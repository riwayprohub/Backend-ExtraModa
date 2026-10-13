-- Imágenes del escaparate de inicio (hero y fondos de categoría).
--
-- Mismo motivo que product_images: el disco de un servicio Render Free se
-- borra en cada reinicio, así que el binario vive en MySQL. `slot` es UNICO:
-- subir otra foto al mismo hueco ('hero-1', 'category-jeans'…) reemplaza la
-- anterior en lugar de acumular imágenes huérfanas.
--
-- `url` es NOT NULL porque las imágenes sembradas usan URLs externas (data
-- NULL) y solo las subidas por el admin llevan binario.

CREATE TABLE `site_images` (
    `id` VARCHAR(191) NOT NULL,
    `slot` VARCHAR(60) NOT NULL,
    `url` VARCHAR(255) NOT NULL,
    `alt_text` VARCHAR(160) NULL,
    `data` MEDIUMBLOB NULL,
    `mime` VARCHAR(60) NULL,
    `bytes` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `site_images_slot_key`(`slot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
