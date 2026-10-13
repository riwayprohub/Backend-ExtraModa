/**
 * "Camiseta Essential" → "camiseta-essential"
 *
 * Vale en utils y no dentro de un módulo porque la usan varios (productos,
 * categorías, cupones...). Normaliza acentos para que un nombre con tilde
 * produzca un slug ASCII válido en la URL.
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 180);
}
