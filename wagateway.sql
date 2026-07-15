-- =====================================================================
-- wagateway - skema database
-- Jalankan langsung di VPS, misal: mysql -u root -p < wagateway.sql
-- =====================================================================

CREATE DATABASE IF NOT EXISTS `wagateway` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `wagateway`;

-- Entitas aplikasi pemanggil (bukan user manusia) - tiap project (Zona Kasir,
-- project lain, dst) punya 1 baris di sini dengan username/password sendiri.
-- Dipakai login Basic Auth ke /send dan /history, dan jadi filter histori.
CREATE TABLE IF NOT EXISTS `aplikasi` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(50) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `nama` VARCHAR(100) NOT NULL,
  `aktif` TINYINT(1) NOT NULL DEFAULT 1,
  `dibuat_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Riwayat tiap pesan yang diminta dikirim. Status di-update belakangan lewat
-- event messages.update dari Baileys (server_ack/delivery_ack/read/error),
-- bukan cuma dicatat sebagai "berhasil dipanggil" doang.
CREATE TABLE IF NOT EXISTS `riwayat_pesan` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `aplikasi_id` INT UNSIGNED NOT NULL,
  `wa_message_id` VARCHAR(100) NULL,
  `nomor_tujuan` VARCHAR(30) NOT NULL,
  `pesan` TEXT NOT NULL,
  `status` ENUM('antri','terkirim','delivered','read','gagal') NOT NULL DEFAULT 'antri',
  `error_pesan` VARCHAR(255) NULL,
  `dikirim_at` DATETIME NULL,
  `status_update_at` DATETIME NULL,
  `dibuat_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_aplikasi` (`aplikasi_id`),
  KEY `idx_wa_message_id` (`wa_message_id`),
  CONSTRAINT `fk_riwayat_aplikasi` FOREIGN KEY (`aplikasi_id`) REFERENCES `aplikasi` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Log ringkas naik-turunnya koneksi WA (buat troubleshooting stabilitas
-- koneksi tanpa harus gali pm2 logs terus).
CREATE TABLE IF NOT EXISTS `koneksi_log` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `event` VARCHAR(30) NOT NULL,
  `detail` VARCHAR(255) NULL,
  `dicatat_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_event` (`event`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
