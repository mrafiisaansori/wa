-- =====================================================================
-- Migrasi: wagateway jadi multi-tenant (tiap aplikasi pairing WA sendiri)
-- Jalankan SEKALI di database yang sudah ada isinya:
--   mysql -u root -p wagateway < migration_multi_tenant.sql
-- Instalasi baru cukup pakai wagateway.sql (sudah termasuk kolom ini).
-- =====================================================================

USE `wagateway`;

ALTER TABLE `koneksi_log` ADD COLUMN `aplikasi_id` INT UNSIGNED NULL AFTER `id`;
ALTER TABLE `koneksi_log` ADD CONSTRAINT `fk_koneksi_aplikasi` FOREIGN KEY (`aplikasi_id`) REFERENCES `aplikasi` (`id`);
ALTER TABLE `koneksi_log` ADD INDEX `idx_koneksi_aplikasi` (`aplikasi_id`);

-- Catatan manual (tidak otomatis lewat SQL): nomor WA yang sudah tertaut
-- sekarang ada di folder ./auth di server. Pindahkan/rename folder itu jadi
-- ./auth/{id_aplikasi_pemilik_nomor_ini} (lihat id di tabel aplikasi) supaya
-- tidak perlu pairing ulang setelah upgrade ke versi multi-tenant ini.
