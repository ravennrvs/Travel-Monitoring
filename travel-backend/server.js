const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { db, verifyPassword, CITIES, addDays } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ===================== UTIL ===================== */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const now = () => new Date().toISOString();
const STATUS = ['Waiting for the Payment', 'Booked', 'Confirmed', 'Cancelled'];
const SLOTS = { all: [0, 24], pagi: [5, 11], siang: [11, 15], sore: [15, 18], malam: [18, 24] };

function randomCode(prefix, len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)];
  return prefix + s;
}
function uniqueBookingCode() {
  for (;;) {
    const k = randomCode('BK', 6);
    if (!db.prepare('SELECT 1 FROM booking WHERE kode_booking_reference=?').get(k)) return k;
  }
}

/* ===================== AUTH ===================== */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const u = token && db.prepare(`SELECT p.id,p.nama,p.email,p.role
    FROM sessions s JOIN pengguna p ON p.id=s.user_id WHERE s.token=?`).get(token);
  if (!u) throw new HttpError(401, 'Silakan login terlebih dahulu.');
  req.user = u;
  next();
}
// Member adalah turunan Pengguna, jadi boleh mengakses fitur Pengguna.
const only = (...roles) => (req, res, next) => {
  const ok = roles.includes(req.user.role) ||
    (roles.includes('pengguna') && req.user.role === 'member');
  if (!ok) throw new HttpError(403, 'Akses ditolak untuk peran Anda.');
  next();
};

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = email && db.prepare('SELECT * FROM pengguna WHERE email=?').get(String(email).toLowerCase());
  if (!u || !verifyPassword(String(password || ''), u.password_hash))
    throw new HttpError(401, 'Email atau password salah.');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,dibuat) VALUES (?,?,?)').run(token, u.id, now());
  res.json({ token, pengguna: { id: u.id, nama: u.nama, email: u.email, role: u.role } });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.headers.authorization.slice(7));
  res.json({ pesan: 'Berhasil logout.' });
});

app.get('/api/auth/me', auth, (req, res) => res.json(req.user));

/* ===================== PENERBANGAN (US02, US03, US04, US06) ===================== */
const FLIGHT_SQL = `
  SELECT p.id, p.kota_asal AS asal, p.kota_tujuan AS tujuan, p.tanggal,
         p.jam_berangkat AS jam, p.jam_tiba AS tiba, p.harga_dasar AS harga,
         p.kursi_tersedia AS kursi, m.nama AS maskapai
  FROM penerbangan p JOIN maskapai m ON m.id = p.maskapai_id`;

function searchFlights({ asal, tujuan, tanggal, jam = 'all', urut = 'harga' }) {
  const [lo, hi] = SLOTS[jam] || SLOTS.all;
  const order = urut === 'jam' ? 'p.jam_berangkat ASC' : 'p.harga_dasar ASC';
  return db.prepare(`${FLIGHT_SQL}
    WHERE p.kota_asal=? AND p.kota_tujuan=? AND p.tanggal=? AND p.kursi_tersedia>0
      AND CAST(substr(p.jam_berangkat,1,2) AS INTEGER) >= ?
      AND CAST(substr(p.jam_berangkat,1,2) AS INTEGER) < ?
    ORDER BY ${order}`).all(asal, tujuan, tanggal, lo, hi);
}
const validCity = c => CITIES.includes(c);

app.get('/api/kota', auth, (req, res) => res.json(CITIES));

// US02a, US03: cari jadwal, maskapai, harga untuk satu atau beberapa tujuan
// GET /api/flights?asal=Jakarta&tujuan=Denpasar,Medan&tanggal=2026-11-20
app.get('/api/flights', auth, only('pengguna', 'manajer'), (req, res) => {
  const { asal, tanggal } = req.query;
  const tujuan = String(req.query.tujuan || '').split(',').filter(Boolean);
  if (!validCity(asal) || !tanggal || !tujuan.length || !tujuan.every(validCity))
    throw new HttpError(400, 'Kota asal, tanggal, dan minimal satu tujuan yang valid wajib diisi.');
  if (tujuan.includes(asal)) throw new HttpError(400, 'Kota tujuan tidak boleh sama dengan kota asal.');
  res.json({
    asal, tanggal,
    hasil: tujuan.map(t => ({ tujuan: t, penerbangan: searchFlights({ asal, tujuan: t, tanggal }) }))
  });
});

// US06: bandingkan berdasarkan tujuan, tanggal, jam keberangkatan (member)
// GET /api/flights/compare?asal=&tujuan=&tanggal=&jam=pagi&urut=harga
app.get('/api/flights/compare', auth, only('member'), (req, res) => {
  const { asal, tujuan, tanggal, jam, urut } = req.query;
  if (!validCity(asal) || !validCity(tujuan) || !tanggal)
    throw new HttpError(400, 'Asal, tujuan, dan tanggal wajib diisi.');
  if (asal === tujuan) throw new HttpError(400, 'Kota asal dan tujuan tidak boleh sama.');
  const list = searchFlights({ asal, tujuan, tanggal, jam, urut });
  const harga = list.map(f => f.harga);
  res.json({
    ringkasan: list.length ? {
      jumlah: list.length, termurah: Math.min(...harga),
      tertinggi: Math.max(...harga), selisih: Math.max(...harga) - Math.min(...harga)
    } : { jumlah: 0 },
    penerbangan: list
  });
});

// US04: multi-destinasi berdasarkan tanggal, lokasi keberangkatan, tujuan (member)
// GET /api/flights/multi?asal=Jakarta&tujuan=Surabaya,Denpasar&tanggal=2026-11-20&jeda=1
app.get('/api/flights/multi', auth, only('member'), (req, res) => {
  const { asal, tanggal } = req.query;
  const jeda = Math.min(Math.max(parseInt(req.query.jeda ?? '1', 10) || 0, 0), 7);
  const tujuan = String(req.query.tujuan || '').split(',').filter(Boolean);
  if (!validCity(asal) || !tanggal || tujuan.length < 2 || !tujuan.every(validCity))
    throw new HttpError(400, 'Pilih lokasi keberangkatan, tanggal, dan minimal 2 tujuan yang valid.');
  const kota = [asal, ...tujuan];
  for (let i = 1; i < kota.length; i++)
    if (kota[i] === kota[i - 1]) throw new HttpError(400, 'Kota yang berurutan tidak boleh sama.');

  const legs = kota.slice(1).map((ke, i) => {
    const tgl = addDays(tanggal, i * jeda);
    const list = searchFlights({ asal: kota[i], tujuan: ke, tanggal: tgl, urut: 'harga' });
    return { dari: kota[i], ke, tanggal: tgl, jumlahPenerbangan: list.length, penerbangan: list };
  });
  const lengkap = legs.every(l => l.jumlahPenerbangan > 0);
  const pick = {
    'Termurah': l => l.reduce((a, b) => (b.harga < a.harga ? b : a)),
    'Paling pagi': l => l.reduce((a, b) => (b.jam < a.jam ? b : a)),
    'Paling malam': l => l.reduce((a, b) => (b.jam > a.jam ? b : a))
  };
  const opsi = lengkap ? Object.entries(pick).map(([nama, fn]) => {
    const dipilih = legs.map(l => fn(l.penerbangan));
    return { nama, jumlahPenerbangan: dipilih.length,
      totalHarga: dipilih.reduce((s, f) => s + f.harga, 0), penerbangan: dipilih };
  }) : [];
  res.json({
    rute: kota, lengkap,
    totalPenerbangan: legs.reduce((s, l) => s + l.jumlahPenerbangan, 0),
    legs, opsi
  });
});

/* ===================== PROFIL MEMBER (US05) ===================== */
function profileOf(userId) {
  return db.prepare(`SELECT p.nama, p.email, p.no_telepon AS telp,
      mp.nomor_identitas AS nik, mp.tanggal_lahir AS lahir
    FROM pengguna p LEFT JOIN member_profile mp ON mp.user_id=p.id WHERE p.id=?`).get(userId);
}
const profileComplete = p => ['nama', 'email', 'telp', 'nik', 'lahir'].every(k => String(p[k] || '').trim());

app.get('/api/profile', auth, only('member'), (req, res) => {
  const p = profileOf(req.user.id);
  res.json({ ...p, statusProfilLengkap: profileComplete(p) });
});

app.put('/api/profile', auth, only('member'), (req, res) => {
  const cur = profileOf(req.user.id);
  const b = req.body || {};
  const next = {
    nama: String(b.nama ?? cur.nama).trim(),
    email: String(b.email ?? cur.email).trim().toLowerCase(),
    telp: String(b.telp ?? cur.telp ?? '').trim(),
    nik: String(b.nik ?? cur.nik ?? '').trim(),
    lahir: String(b.lahir ?? cur.lahir ?? '').trim()
  };
  if (!next.nama || !next.email) throw new HttpError(400, 'Nama dan email tidak boleh kosong.');
  try {
    db.transaction(() => {
      db.prepare('UPDATE pengguna SET nama=?, email=?, no_telepon=? WHERE id=?')
        .run(next.nama, next.email, next.telp, req.user.id);
      db.prepare(`INSERT INTO member_profile (user_id,nomor_identitas,tanggal_lahir) VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET nomor_identitas=excluded.nomor_identitas,
        tanggal_lahir=excluded.tanggal_lahir`).run(req.user.id, next.nik, next.lahir);
    })();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Email sudah dipakai akun lain.');
    throw e;
  }
  res.json({ pesan: 'Profil berhasil disimpan.', profil: next, statusProfilLengkap: profileComplete(next) });
});

/* ===================== BOOKING ===================== */
const BOOKING_SQL = `
  SELECT b.*, o.nama AS pemilik, pm.nama AS pemesan_nama, pm.role AS pemesan_role
  FROM booking b
  JOIN pengguna o  ON o.id  = b.user_id
  JOIN pengguna pm ON pm.id = b.pemesan_id`;

function detailBooking(b) {
  const tiket = db.prepare(`
    SELECT t.nomor_tiket AS nomor, t.kelas, t.harga_tiket AS harga,
           t.status_validasi AS validasi, t.tanggal_kirim_etiket AS tanggalKirimETiket,
           p.id AS penerbanganId, p.kota_asal AS asal, p.kota_tujuan AS tujuan,
           p.tanggal, p.jam_berangkat AS jam, p.jam_tiba AS tiba, m.nama AS maskapai
    FROM tiket t
    JOIN penerbangan p ON p.id = t.penerbangan_id
    JOIN maskapai m ON m.id = p.maskapai_id
    WHERE t.booking_id=? ORDER BY p.tanggal, p.jam_berangkat`).all(b.id)
    .map(t => ({ ...t, validasi: !!t.validasi }));
  return {
    kodeBookingReference: b.kode_booking_reference,
    tanggalBooking: b.tanggal_booking,
    status: b.status,
    totalHarga: b.total_harga,
    atasNama: b.pemilik,
    dipesanOleh: b.pemesan_role === 'manajer' ? 'Manajer Travel'
      : b.pemesan_role === 'member' ? 'Member' : 'Pengguna',
    penumpang: { nama: b.nama_penumpang, nik: b.nik_penumpang, email: b.email_penumpang },
    tiket
  };
}
function findBooking(kode) {
  return db.prepare(`${BOOKING_SQL} WHERE b.kode_booking_reference=?`).get(String(kode).toUpperCase());
}
function mustOwnOrManage(req, b) {
  if (req.user.role !== 'manajer' && b.user_id !== req.user.id)
    throw new HttpError(403, 'Anda tidak berhak mengakses booking ini.');
}

// Pengiriman e-tiket (disimulasikan lewat tabel outbox)
function sendETicket(bookingId) {
  const b = db.prepare(`${BOOKING_SQL} WHERE b.id=?`).get(bookingId);
  const d = detailBooking(b);
  const isi = [`Halo ${d.penumpang.nama},`, `Kode booking: ${d.kodeBookingReference}`,
    ...d.tiket.map(t => `- ${t.nomor}: ${t.asal} -> ${t.tujuan}, ${t.tanggal} ${t.jam}, ${t.maskapai}`),
    `Total: Rp ${d.totalHarga.toLocaleString('id-ID')}`].join('\n');
  db.transaction(() => {
    db.prepare('INSERT INTO outbox (kepada,subjek,isi,dikirim) VALUES (?,?,?,?)')
      .run(d.penumpang.email, `E-Tiket ${d.kodeBookingReference}`, isi, now());
    db.prepare('UPDATE tiket SET tanggal_kirim_etiket=? WHERE booking_id=?').run(now(), bookingId);
  })();
}

// Membuat booking + tiket + mengurangi kursi, semuanya atomik (cegah double-booking)
const createBooking = db.transaction((ownerId, pemesanId, flightIds, pen) => {
  const ids = [...new Set(flightIds)];
  const flights = ids.map(id => {
    const f = db.prepare('SELECT * FROM penerbangan WHERE id=?').get(id);
    if (!f) throw new HttpError(404, `Penerbangan #${id} tidak ditemukan.`);
    return f;
  });
  for (const f of flights) {
    const r = db.prepare(
      'UPDATE penerbangan SET kursi_tersedia=kursi_tersedia-1 WHERE id=? AND kursi_tersedia>0').run(f.id);
    if (r.changes === 0)
      throw new HttpError(409, `Penerbangan ${f.kota_asal} → ${f.kota_tujuan} (${f.tanggal} ${f.jam_berangkat}) sudah tidak tersedia.`);
  }
  const total = flights.reduce((s, f) => s + f.harga_dasar, 0);
  const kode = uniqueBookingCode();
  const bk = db.prepare(`INSERT INTO booking
    (kode_booking_reference,user_id,pemesan_id,tanggal_booking,status,total_harga,nama_penumpang,nik_penumpang,email_penumpang)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(kode, ownerId, pemesanId, now(), 'Waiting for the Payment', total, pen.nama, pen.nik || '', pen.email);
  const insT = db.prepare(`INSERT INTO tiket (nomor_tiket,booking_id,penerbangan_id,kelas,harga_tiket)
    VALUES (?,?,?,?,?)`);
  flights.forEach((f, i) => insT.run(`TK-${kode.slice(2)}-${i + 1}`, bk.lastInsertRowid, f.id, 'Ekonomi', f.harga_dasar));
  return { id: Number(bk.lastInsertRowid), kode };
});

// US02b, US06c, US08b: buat pemesanan
// Body: { flightIds:[1,2], penumpang:{nama,nik,email}, untukPenggunaId? (khusus manajer) }
app.post('/api/bookings', auth, (req, res) => {
  const { flightIds, penumpang, untukPenggunaId } = req.body || {};
  if (!Array.isArray(flightIds) || !flightIds.length || flightIds.some(i => !Number.isInteger(i)))
    throw new HttpError(400, 'flightIds wajib berupa array angka dan tidak boleh kosong.');
  const pen = penumpang || {};
  if (!String(pen.nama || '').trim() || !String(pen.email || '').trim())
    throw new HttpError(400, 'Nama dan email penumpang wajib diisi.');

  let ownerId = req.user.id;
  if (req.user.role === 'manajer') {
    // US08: manajer memesan atas nama pengunjung
    const target = db.prepare('SELECT id,role FROM pengguna WHERE id=?').get(untukPenggunaId);
    if (!target || target.role === 'manajer')
      throw new HttpError(400, 'Pengunjung tujuan tidak valid.');
    ownerId = target.id;
  }
  const { id, kode } = createBooking(ownerId, req.user.id, flightIds,
    { nama: pen.nama.trim(), nik: String(pen.nik || '').trim(), email: pen.email.trim() });

  // US08 d: e-tiket dikirim ke email pengunjung saat manajer memesan.
  if (req.user.role === 'manajer') sendETicket(id);

  res.status(201).json({
    pesan: req.user.role === 'manajer'
      ? `Pesanan ${kode} dibuat atas nama pengunjung. E-tiket dikirim ke ${pen.email}.`
      : `Booking ${kode} dibuat. Silakan lanjutkan pembayaran.`,
    booking: detailBooking(findBooking(kode))
  });
});

// US02c, US08c: daftar tiket milik akun yang login
app.get('/api/bookings/mine', auth, (req, res) => {
  const rows = db.prepare(`${BOOKING_SQL} WHERE b.user_id=? ORDER BY b.id DESC`).all(req.user.id);
  res.json(rows.map(detailBooking));
});

// US07: manajer melihat semua booking, filter status
// GET /api/bookings?status=Booked
app.get('/api/bookings', auth, only('manajer'), (req, res) => {
  const { status } = req.query;
  if (status && status !== 'Semua' && !STATUS.includes(status))
    throw new HttpError(400, 'Status tidak valid.');
  const rows = (status && status !== 'Semua')
    ? db.prepare(`${BOOKING_SQL} WHERE b.status=? ORDER BY b.id DESC`).all(status)
    : db.prepare(`${BOOKING_SQL} ORDER BY b.id DESC`).all();
  const hitung = {};
  STATUS.forEach(s => (hitung[s] = db.prepare('SELECT COUNT(*) c FROM booking WHERE status=?').get(s).c));
  res.json({ total: db.prepare('SELECT COUNT(*) c FROM booking').get().c, hitung, booking: rows.map(detailBooking) });
});

app.get('/api/bookings/:kode', auth, (req, res) => {
  const b = findBooking(req.params.kode);
  if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
  mustOwnOrManage(req, b);
  res.json(detailBooking(b));
});

// Pembayaran: Waiting for the Payment -> Booked
app.post('/api/bookings/:kode/pay', auth, (req, res) => {
  const b = findBooking(req.params.kode);
  if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
  if (b.user_id !== req.user.id) throw new HttpError(403, 'Hanya pemilik booking yang dapat membayar.');
  if (b.status !== 'Waiting for the Payment')
    throw new HttpError(409, `Booking berstatus "${b.status}", tidak dapat dibayar.`);
  const metode = String((req.body || {}).metode || 'Transfer Bank');
  db.transaction(() => {
    db.prepare('INSERT INTO pembayaran (booking_id,jumlah,metode,status,tanggal_bayar) VALUES (?,?,?,?,?)')
      .run(b.id, b.total_harga, metode, 'Berhasil', now());
    db.prepare("UPDATE booking SET status='Booked' WHERE id=?").run(b.id);
  })();
  const belumKirim = db.prepare(
    'SELECT 1 FROM tiket WHERE booking_id=? AND tanggal_kirim_etiket IS NULL').get(b.id);
  if (belumKirim) sendETicket(b.id);
  res.json({ pesan: `Pembayaran berhasil. E-tiket dikirim ke ${b.email_penumpang}.`,
    booking: detailBooking(findBooking(b.kode_booking_reference)) });
});

// US02c: batalkan pesanan (kursi dikembalikan)
app.post('/api/bookings/:kode/cancel', auth, (req, res) => {
  const b = findBooking(req.params.kode);
  if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
  mustOwnOrManage(req, b);
  if (b.status === 'Cancelled') throw new HttpError(409, 'Booking sudah dibatalkan.');
  db.transaction(() => {
    db.prepare(`UPDATE penerbangan SET kursi_tersedia=kursi_tersedia+1
      WHERE id IN (SELECT penerbangan_id FROM tiket WHERE booking_id=?)`).run(b.id);
    db.prepare("UPDATE booking SET status='Cancelled' WHERE id=?").run(b.id);
    db.prepare("UPDATE pembayaran SET status='Dikembalikan' WHERE booking_id=?").run(b.id);
  })();
  res.json({ pesan: `Pesanan ${b.kode_booking_reference} dibatalkan.`,
    booking: detailBooking(findBooking(b.kode_booking_reference)) });
});

/* ===================== VALIDASI TIKET (US05) ===================== */
app.post('/api/tickets/:nomor/validate', auth, only('member'), (req, res) => {
  const t = db.prepare(`SELECT t.id, t.status_validasi, b.user_id, b.status
    FROM tiket t JOIN booking b ON b.id=t.booking_id WHERE t.nomor_tiket=?`).get(req.params.nomor);
  if (!t || t.user_id !== req.user.id) throw new HttpError(404, 'Tiket tidak ditemukan.');
  if (t.status === 'Cancelled') throw new HttpError(409, 'Tiket pada booking yang dibatalkan tidak dapat divalidasi.');
  if (!profileComplete(profileOf(req.user.id)))
    throw new HttpError(422, 'Data profil tidak lengkap'); // ditolak sampai profil lengkap
  db.prepare('UPDATE tiket SET status_validasi=1 WHERE id=?').run(t.id);
  res.json({ pesan: `Tiket ${req.params.nomor} berhasil divalidasi.` });
});

/* ===================== OTORISASI (US09) ===================== */
// Cek kode booking reference
app.get('/api/otorisasi/:kode', auth, only('manajer'), (req, res) => {
  const b = findBooking(req.params.kode);
  if (!b) throw new HttpError(404, 'Kode booking reference tidak sesuai');
  res.json(detailBooking(b));
});

// Otorisasi: Booked -> Confirmed, dicatat pada tabel otorisasi
app.post('/api/otorisasi/:kode', auth, only('manajer'), (req, res) => {
  const b = findBooking(req.params.kode);
  if (!b) throw new HttpError(404, 'Kode booking reference tidak sesuai');
  if (b.status === 'Waiting for the Payment') throw new HttpError(409, 'Booking masih menunggu pembayaran, belum dapat diotorisasi.');
  if (b.status === 'Confirmed') throw new HttpError(409, 'Tiket sudah diotorisasi (Confirmed).');
  if (b.status === 'Cancelled') throw new HttpError(409, 'Booking telah dibatalkan.');
  db.transaction(() => {
    db.prepare("UPDATE booking SET status='Confirmed' WHERE id=?").run(b.id);
    db.prepare('INSERT INTO otorisasi (booking_id,manajer_id,tanggal_otorisasi,hasil_verifikasi) VALUES (?,?,?,?)')
      .run(b.id, req.user.id, now(), 'Terverifikasi');
  })();
  res.json({ pesan: `Tiket ${b.kode_booking_reference} berhasil diotorisasi.`,
    booking: detailBooking(findBooking(b.kode_booking_reference)) });
});

/* ===================== DATA PENDUKUNG ===================== */
// Daftar pengunjung untuk dropdown pemesanan oleh manajer (US08)
app.get('/api/pengunjung', auth, only('manajer'), (req, res) => {
  res.json(db.prepare(`SELECT p.id, p.nama, p.email, COALESCE(mp.nomor_identitas,'') AS nik
    FROM pengguna p LEFT JOIN member_profile mp ON mp.user_id=p.id
    WHERE p.role IN ('pengguna','member') ORDER BY p.nama`).all());
});

// Kotak keluar email (demo): untuk memeriksa e-tiket yang "terkirim"
app.get('/api/outbox', auth, only('manajer'), (req, res) => {
  res.json(db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 50').all());
});

/* ===================== ERROR HANDLING ===================== */
app.use('/api', (req, res) => res.status(404).json({ pesan: 'Endpoint tidak ditemukan.' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ pesan: err.message });
  console.error(err);
  res.status(500).json({ pesan: 'Terjadi kesalahan pada server.' });
});

/* ===================== DATA DEMO BOOKING ===================== */
function seedDemo() {
  if (db.prepare('SELECT 1 FROM booking LIMIT 1').get()) return;
  const uid = e => db.prepare('SELECT id FROM pengguna WHERE email=?').get(e).id;
  const fid = (a, b, off) => db.prepare(`SELECT id FROM penerbangan WHERE kota_asal=? AND kota_tujuan=?
    ORDER BY tanggal,jam_berangkat LIMIT 1 OFFSET ?`).get(a, b, off).id;
  const mk = (owner, pemesan, flight, status, nama, email) => {
    const r = createBooking(uid(owner), uid(pemesan), [flight], { nama, nik: '-', email });
    db.prepare('UPDATE booking SET status=? WHERE id=?').run(status, r.id);
    if (status !== 'Waiting for the Payment')
      db.prepare('INSERT INTO pembayaran (booking_id,jumlah,metode,status,tanggal_bayar) SELECT id,total_harga,?,?,? FROM booking WHERE id=?')
        .run('Transfer Bank', 'Berhasil', now(), r.id);
  };
  mk('budi@email.com', 'budi@email.com', fid('Jakarta', 'Denpasar', 0), 'Confirmed', 'Budi Santoso', 'budi@email.com');
  mk('budi@email.com', 'budi@email.com', fid('Surabaya', 'Malang', 1), 'Waiting for the Payment', 'Budi Santoso', 'budi@email.com');
  mk('siti@email.com', 'manajer@email.com', fid('Jakarta', 'Medan', 2), 'Booked', 'Siti Aminah', 'siti@email.com');
  mk('rudi@email.com', 'manajer@email.com', fid('Malang', 'Jakarta', 3), 'Waiting for the Payment', 'Rudi Hartono', 'rudi@email.com');
}
seedDemo();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
