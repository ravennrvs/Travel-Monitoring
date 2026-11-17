const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database(process.env.DB_FILE || 'travel.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ===================== SKEMA ===================== */
db.exec(`
CREATE TABLE IF NOT EXISTS pengguna (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('pengguna','member','manajer')),
  no_telepon TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS member_profile (
  user_id INTEGER PRIMARY KEY REFERENCES pengguna(id),
  nomor_identitas TEXT NOT NULL DEFAULT '',
  tanggal_lahir TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS maskapai (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS penerbangan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maskapai_id INTEGER NOT NULL REFERENCES maskapai(id),
  kota_asal TEXT NOT NULL,
  kota_tujuan TEXT NOT NULL,
  tanggal TEXT NOT NULL,
  jam_berangkat TEXT NOT NULL,
  jam_tiba TEXT NOT NULL,
  harga_dasar INTEGER NOT NULL,
  kursi_tersedia INTEGER NOT NULL DEFAULT 60
);
CREATE INDEX IF NOT EXISTS idx_penerbangan_cari
  ON penerbangan(kota_asal, kota_tujuan, tanggal);

CREATE TABLE IF NOT EXISTS booking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode_booking_reference TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES pengguna(id),     -- pemilik / atas nama
  pemesan_id INTEGER NOT NULL REFERENCES pengguna(id),  -- yang melakukan pemesanan
  tanggal_booking TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('Waiting for the Payment','Booked','Confirmed','Cancelled')),
  total_harga INTEGER NOT NULL,
  nama_penumpang TEXT NOT NULL,
  nik_penumpang TEXT NOT NULL DEFAULT '',
  email_penumpang TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tiket (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nomor_tiket TEXT NOT NULL UNIQUE,
  booking_id INTEGER NOT NULL REFERENCES booking(id),
  penerbangan_id INTEGER NOT NULL REFERENCES penerbangan(id),
  kelas TEXT NOT NULL DEFAULT 'Ekonomi',
  harga_tiket INTEGER NOT NULL,
  status_validasi INTEGER NOT NULL DEFAULT 0,
  tanggal_kirim_etiket TEXT
);

CREATE TABLE IF NOT EXISTS pembayaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES booking(id),
  jumlah INTEGER NOT NULL,
  metode TEXT NOT NULL,
  status TEXT NOT NULL,
  tanggal_bayar TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otorisasi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES booking(id),
  manajer_id INTEGER NOT NULL REFERENCES pengguna(id),
  tanggal_otorisasi TEXT NOT NULL,
  hasil_verifikasi TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES pengguna(id),
  dibuat TEXT NOT NULL
);

-- Pengganti pengiriman email sungguhan (lihat catatan di bawah)
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kepada TEXT NOT NULL,
  subjek TEXT NOT NULL,
  isi TEXT NOT NULL,
  dikirim TEXT NOT NULL
);
`);

/* ===================== HELPER ===================== */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return toISO(dt);
}
function addMin(t, m) {
  const [h, mi] = t.split(':').map(Number);
  const tot = h * 60 + mi + m;
  return pad(Math.floor(tot / 60) % 24) + ':' + pad(tot % 60);
}

/* ===================== SEED ===================== */
const CITIES = ['Jakarta', 'Surabaya', 'Malang', 'Denpasar', 'Yogyakarta', 'Medan'];

function seed() {
  if (!db.prepare('SELECT 1 FROM pengguna LIMIT 1').get()) {
    const ins = db.prepare(
      'INSERT INTO pengguna (nama,email,password_hash,role,no_telepon) VALUES (?,?,?,?,?)');
    const users = [
      ['Budi Santoso',  'budi@email.com',    'password123', 'pengguna', ''],
      ['Siti Aminah',   'siti@email.com',    'password123', 'pengguna', ''],
      ['Rudi Hartono',  'rudi@email.com',    'password123', 'pengguna', ''],
      ['Maya Lestari',  'member@email.com',  'password123', 'member',   ''],
      ['Rahmat Manajer','manajer@email.com', 'password123', 'manajer',  '081200000000']
    ];
    for (const [n, e, p, r, t] of users) ins.run(n, e, hashPassword(p), r, t);
    const member = db.prepare('SELECT id FROM pengguna WHERE email=?').get('member@email.com');
    db.prepare('INSERT INTO member_profile (user_id) VALUES (?)').run(member.id); // profil sengaja belum lengkap
  }

  if (!db.prepare('SELECT 1 FROM penerbangan LIMIT 1').get()) {
    const AIRLINES = [['Garuda Indonesia', 1.35], ['Batik Air', 1.1], ['Citilink', 0.95], ['Lion Air', 0.85]];
    const TIMES = ['06:00', '09:30', '13:15', '17:45', '20:30'];
    const DAYS = 30;
    const start = toISO(new Date());

    const insM = db.prepare('INSERT OR IGNORE INTO maskapai (nama) VALUES (?)');
    AIRLINES.forEach(([n]) => insM.run(n));
    const mid = {};
    db.prepare('SELECT id,nama FROM maskapai').all().forEach(m => (mid[m.nama] = m.id));

    const insF = db.prepare(`INSERT INTO penerbangan
      (maskapai_id,kota_asal,kota_tujuan,tanggal,jam_berangkat,jam_tiba,harga_dasar,kursi_tersedia)
      VALUES (?,?,?,?,?,?,?,60)`);
    db.transaction(() => {
      CITIES.forEach((a, i) => CITIES.forEach((b, j) => {
        if (a === b) return;
        const base = 550000 + ((i * 7 + j * 11) % 9) * 90000;
        for (let d = 0; d < DAYS; d++) {
          AIRLINES.forEach(([nama, f], k) => {
            [0, 1].forEach(s => {
              const jam = TIMES[(k * 2 + s + d) % TIMES.length];
              const adj = jam < '08:00' ? -0.05 : (jam > '17:00' ? 0.08 : 0);
              const harga = Math.round(base * f * (1 + (d % 5) * 0.03 + adj) / 1000) * 1000;
              insF.run(mid[nama], a, b, addDays(start, d), jam, addMin(jam, 80 + ((i + j) % 4) * 20), harga);
            });
          });
        }
      }));
    })();
  }
}
seed();

module.exports = { db, hashPassword, verifyPassword, CITIES, addDays };
