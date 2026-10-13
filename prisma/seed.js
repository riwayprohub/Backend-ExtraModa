/**
 * Seed de Extramoda — datos base para desarrollo.
 * Ejecutar:  npx prisma db seed   (o  npm run prisma:seed)
 *
 * Es IDEMPOTENTE en cuanto a claves (upsert por slug/sku/código), así que
 * puedes ejecutarlo varias veces. Si quieres un reset total, borra primero los
 * datos con `npx prisma migrate reset`.
 *
 * TIENDA DE ROPA FEMENINA. El catálogo se Siembra SIN productos a propósito:
 * el panel de gestión es la vía para crear el catálogo real, y unos productos
 * de prueba en la base solo acabarían borrándose a mano (o peor, vendiéndose
 * por error). Lo que sí siembra es lo que la tienda necesita para funcionar:
 * las 10 categorías fijas, las fotos del escaparate de inicio y los cupones.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PASSWORD = 'Password123!';

const slugify = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

async function main() {
  console.log('🌱 Sembrando Extramoda...\n');

  // ── 1. Atributos (Color, Talla, Material, Corte) ───────────────────────────
  const attributeDefs = [
    {
      name: 'Color',
      slug: 'color',
      values: [
        { label: 'Negro', value: 'negro', hexColor: '#111111' },
        { label: 'Blanco', value: 'blanco', hexColor: '#FFFFFF' },
        { label: 'Arena', value: 'arena', hexColor: '#E5DCC8' },
        { label: 'Verde oliva', value: 'verde-oliva', hexColor: '#6B7A45' },
        { label: 'Azul marino', value: 'azul-marino', hexColor: '#1F2A44' },
        { label: 'Granate', value: 'granate', hexColor: '#6E1E2A' },
        { label: 'Rosa', value: 'rosa', hexColor: '#E8B4B8' },
      ],
    },
    {
      name: 'Talla',
      slug: 'talla',
      values: [
        { label: 'XS', value: 'xs' },
        { label: 'S', value: 's' },
        { label: 'M', value: 'm' },
        { label: 'L', value: 'l' },
        { label: 'XL', value: 'xl' },
        { label: 'XXL', value: 'xxl' },
      ],
    },
    {
      name: 'Material',
      slug: 'material',
      type: 'TEXT',
      isFilterable: false,
      values: [
        { label: 'Algodón orgánico', value: 'algodon-organico' },
        { label: 'Lino', value: 'lino' },
        { label: 'Denim', value: 'denim' },
        { label: 'Merino', value: 'merino' },
        { label: 'Poliéster reciclado', value: 'poliester-reciclado' },
      ],
    },
    {
      name: 'Corte',
      slug: 'corte',
      isFilterable: false,
      values: [
        { label: 'Regular', value: 'regular' },
        { label: 'Slim', value: 'slim' },
        { label: 'Oversize', value: 'oversize' },
      ],
    },
  ];

  const attributes = {};
  for (const def of attributeDefs) {
    const attribute = await prisma.attribute.upsert({
      where: { slug: def.slug },
      update: { name: def.name, type: def.type ?? 'SELECT', isFilterable: def.isFilterable ?? true },
      create: {
        name: def.name,
        slug: def.slug,
        type: def.type ?? 'SELECT',
        isFilterable: def.isFilterable ?? true,
      },
    });

    const values = {};
    for (const [index, valueDef] of def.values.entries()) {
      // id determinista: permite upsert estable entre ejecuciones del seed.
      //
      // OJO con el formato: el id tiene parecerse a un cuid válido (empieza por
      // 'c', sin guiones ni espacios) porque viaja al frontend y vuelve en el
      // body de PATCH/POST de variantes, donde Zod valida `z.string().cuid()`.
      // La primera versión usaba `${attribute.id}-${value}` y el guion la
      // invalidaba: el panel no podía crear variantes con color o talla.
      const valueId = `${attribute.id}${valueDef.value.replace(/[^a-z0-9]/gi, '')}`;
      const value = await prisma.attributeValue.upsert({
        where: { id: valueId },
        update: valueDef,
        create: {
          id: valueId,
          attributeId: attribute.id,
          position: index,
          ...valueDef,
        },
      });
      values[valueDef.value] = value;
    }
    attributes[def.slug] = values;
    console.log(`  ✓ ${def.name} (${def.values.length} valores)`);
  }

  // ── 2. Categorías (las 10 fijas de la tienda, en orden alfabético) ─────────
  //
  // La posición ES el orden alfabético: el selector de categorías del panel y
  // la portada las muestran en este orden sin tener que reordenar a mano.
  const categoryNames = [
    'Accesorios',
    'Abrigos',
    'Blusas',
    'Calzados',
    'Faldas',
    'Jeans',
    'Remeras',
    'Shorts',
    'Sweater',
    'Vestidos',
  ];

  for (const [index, name] of categoryNames.entries()) {
    await prisma.category.upsert({
      where: { slug: slugify(name) },
      update: { name, position: index, isActive: true },
      create: {
        name,
        slug: slugify(name),
        description: `${name} de ropa femenina`,
        position: index,
      },
    });
  }

  // Categorías FUERA de la lista fija se borran. La tienda tiene exactamente
  // estas 10: una categoría antigua que sobrevive en la BD se cuela en los
  // filtros del catálogo y en el selector del panel como si fuera real. (Un
  // upsert por slug no basta al renombrar: "Sweaters" → "Sweater" cambiaría el
  // slug y dejaría la fila vieja huérfana.)
  const fixedSlugs = categoryNames.map((name) => slugify(name));
  const { count: purged } = await prisma.category.deleteMany({
    where: { slug: { notIn: fixedSlugs } }
  });
  if (purged > 0) console.log(`  · ${purged} categoría(s) antigua(s) eliminada(s)`);

  console.log(`  ✓ ${categoryNames.length} categorías (orden alfabético)`);

  // ── 3. Marca ───────────────────────────────────────────────────────────────
  await prisma.brand.upsert({
    where: { slug: 'extramoda' },
    update: {},
    create: {
      name: 'Extramoda',
      slug: 'extramoda',
      description: 'Marca propia de moda femenina con diseño atemporal.',
    },
  });

  // ── 4. Usuarios ────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(PASSWORD, 12); // 12 rounds = coste razonable en 2026
  const admin = await prisma.user.upsert({
    where: { email: 'admin@extramoda.es' },
    update: { passwordHash },
    create: {
      email: 'admin@extramoda.es',
      passwordHash,
      firstName: 'Ana',
      lastName: 'Administradora',
      phone: '+59168687480',
      role: 'ADMIN',
      isVerified: true,
    },
  });
  const customer = await prisma.user.upsert({
    where: { email: 'cliente@ejemplo.com' },
    update: { passwordHash },
    create: {
      email: 'cliente@ejemplo.com',
      passwordHash,
      firstName: 'Carlos',
      lastName: 'García',
      phone: '+59168687481',
      role: 'CUSTOMER',
      isVerified: true,
      addresses: {
        create: [
          {
            type: 'SHIPPING',
            label: 'Casa',
            firstName: 'Carlos',
            lastName: 'García',
            line1: 'Av. Ballivián 123',
            city: 'Cochabamba',
            province: 'Cochabamba',
            postalCode: '0000',
            countryCode: 'BO',
            phone: '+59168687481',
            isDefault: true,
          },
        ],
      },
    },
  });
  console.log('  ✓ 2 usuarios (admin + cliente)');

  // ── 5. Cupones ─────────────────────────────────────────────────────────────
  await prisma.coupon.upsert({
    where: { code: 'BIENVENIDA10' },
    update: {},
    create: {
      code: 'BIENVENIDA10',
      description: '10 % de descuento en tu primera compra',
      type: 'PERCENTAGE',
      value: 10,
      maxDiscount: 50, // techo: máximo Bs 50 de descuento
      minSubtotal: 40,
      perUserLimit: 1,
      usageLimit: 1000,
      isActive: true,
    },
  });
  await prisma.coupon.upsert({
    where: { code: 'ENVIOGRATIS' },
    update: {},
    create: {
      code: 'ENVIOGRATIS',
      description: 'Envío gratuito en pedidos superiores a Bs 60',
      type: 'FREE_SHIPPING',
      value: 0,
      minSubtotal: 60,
      isActive: true,
    },
  });
  console.log('  ✓ 2 cupones (BIENVENIDA10, ENVIOGRATIS)');

  // ── 6. Imágenes del escaparate de inicio (hero + 6 fondos de categoría) ────
  //
  // Fotos externas de placeholder relacionadas con cada hueco. El admin las
  // reemplaza desde el panel ("Imágenes de inicio"), que guarda el binario en
  // la base de datos: al subir una, `url` pasa a apuntar a /api/v1/site-images.
  const siteImages = [
    {
      slot: 'hero-1',
      url: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=900&q=80',
      altText: 'Looks de moda femenina de la nueva colección',
    },
    {
      slot: 'hero-2',
      url: 'https://images.unsplash.com/photo-1495385794356-15371f348c31?w=900&q=80',
      altText: 'Detalle de prendas de la colección',
    },
    {
      slot: 'category-accesorios',
      url: 'https://images.unsplash.com/photo-1611085583191-a3b181a88401?w=800&q=80',
      altText: 'Accesorios de moda femenina',
    },
    {
      slot: 'category-abrigos',
      url: 'https://images.unsplash.com/photo-1539533018447-63fcce2678e3?w=800&q=80',
      altText: 'Abrigos y tapados',
    },
    {
      slot: 'category-blusas',
      url: 'https://images.unsplash.com/photo-1598554747436-c9293d6a588f?w=800&q=80',
      altText: 'Blusas livianas',
    },
    {
      slot: 'category-calzados',
      url: 'https://images.unsplash.com/photo-1543163521-1bf539c55dd2?w=800&q=80',
      altText: 'Calzado femenino',
    },
    {
      slot: 'category-faldas',
      url: 'https://images.unsplash.com/photo-1583496661160-fb5886a0aaaa?w=800&q=80',
      altText: 'Faldas',
    },
    {
      slot: 'category-jeans',
      url: 'https://images.unsplash.com/photo-1541099649105-f69ad21f3246?w=800&q=80',
      altText: 'Jeans',
    },
  ];

  for (const image of siteImages) {
    await prisma.siteImage.upsert({
      where: { slot: image.slot },
      // El update NO toca el binario: si el admin ya subió su foto, reejecutar
      // el seed no debe pisársela con el placeholder.
      update: {},
      create: image,
    });
  }
  console.log(`  ✓ ${siteImages.length} imágenes del inicio (hero + categorías)`);

  // ── 7. Newsletter ───────────────────────────────────────────────────────────
  await prisma.newsletterSubscriber.upsert({
    where: { email: 'interesado@ejemplo.com' },
    update: {},
    create: {
      email: 'interesado@ejemplo.com',
      token: 'token-demo-doble-optin-abc123',
      isSubscribed: true,
      confirmedAt: new Date(),
    },
  });

  // ── Resumen ────────────────────────────────────────────────────────────────
  const [nProducts, nCategories, nImages] = await Promise.all([
    prisma.product.count(),
    prisma.category.count(),
    prisma.siteImage.count(),
  ]);

  console.log('\n✅ Seed completado');
  console.log(`   Productos: ${nProducts} (el catálogo se crea desde el panel) | Categorías: ${nCategories} | Imágenes de inicio: ${nImages}`);
  console.log('\n🔑 Usuarios de prueba (contraseña: %s)', PASSWORD);
  console.log('   admin@extramoda.es   → ADMIN');
  console.log('   cliente@ejemplo.com  → CUSTOMER');
  console.log('\n💡 Cupones: BIENVENIDA10 (10 % máx. Bs 50) · ENVIOGRATIS (envío gratis > Bs 60)');
}

main()
  .catch((error) => {
    console.error('❌ Error sembrando:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
