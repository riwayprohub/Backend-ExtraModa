-- Las imagenes subidas por el admin se guardan en la base de datos.
--
-- Motivo: el disco de un servicio Render Free se borra en cada reinicio y en
-- cada despliegues, asi que un fichero en UPLOAD_DIR desapareceria. MySQL si
-- sobrevive, y asi imagenes y producto viajan siempre juntos.
--
-- MEDIUMBLOB admite hasta 16 MB por imagen, muy por encima del tope de 2 MB que
-- impone el middleware de subida. `url` sigue siendo NOT NULL porque las
-- imagenes de seed (URLs externas) no tienen binario: data y mime son NULL.

ALTER TABLE `product_images` ADD COLUMN `data` MEDIUMBLOB NULL;
ALTER TABLE `product_images` ADD COLUMN `mime` VARCHAR(60) NULL;
ALTER TABLE `product_images` ADD COLUMN `bytes` INTEGER NULL;