# SkyTravel: Pemesanan & Monitoring Tiket Pesawat
SkyTravel membantu pengguna mencari, memesan, dan memantau tiket pesawat dalam satu
tempat. Sistem membedakan tiga peran (Pengguna, Member Frequent Traveller, dan
Manajer Travel), masing-masing dengan fitur dan hak akses sendiri.

## Fungsi Utama
- **Mencari jadwal penerbangan**: pengguna memilih kota asal, tanggal, dan satu atau
  beberapa tujuan, lalu sistem menampilkan jadwal, maskapai, dan harga tiket.
- **Memesan, membayar, dan membatalkan tiket**: pengguna memesan tiket yang diinginkan,
  membayar pesanan, dan dapat membatalkannya. Pesanan yang dibatalkan mengembalikan kursi.
- **Penerbangan multi-destinasi** (Member): member mencari rute berantai berdasarkan
  tanggal, lokasi keberangkatan, dan tujuan, lalu membandingkan harga dan jumlah
  penerbangan.
- **Membandingkan penerbangan** (Member): member membandingkan penerbangan berdasarkan
  tujuan, tanggal, dan jam keberangkatan, lalu memesan tiket yang dipilih.
- **Profil dan validasi tiket** (Member): member melengkapi data profil untuk memvalidasi
  tiket. Jika profil belum lengkap, sistem menampilkan pesan "Data profil tidak lengkap"
  dan menolak validasi.
- **Monitoring status booking** (Manajer): manajer travel melihat seluruh booking dan
  memfilter berdasarkan status (Waiting for the Payment, Booked, Confirmed, Cancelled).
- **Memesan untuk pengunjung** (Manajer): manajer travel mencari dan memesan tiket atas
  nama pengunjung. Pengunjung dapat melihat tiketnya di akun dan menerima e-tiket
  melalui email.
- **Otorisasi tiket** (Manajer): manajer travel memverifikasi booking menggunakan kode
  booking reference. Jika kode tidak sesuai, sistem menampilkan pesan "Kode booking
  reference tidak sesuai" dan meminta input ulang.

## Alur Status Booking
Waiting for the Payment → (dibayar) → Booked → (diotorisasi manajer) → Confirmed
Pesanan yang dibatalkan berstatus Cancelled.

## Cara Menggunakan
1. Masuk ke folder backend, lalu pasang dependensi dan jalankan server:

   ```bash
   cd travel-backend
   npm install
   npm start
   ```
   
2. Buka `http://localhost:3000/travel.html` di browser.
3. Login menggunakan salah satu akun demo di bawah, sesuai peran yang ingin dicoba.
4. Gunakan menu yang tersedia sesuai peran: cari penerbangan, pesan tiket, bayar,
   validasi, lihat status booking, atau otorisasi.

## Akun Demo
| Peran | Email | Password |
|---|---|---|
| Pengguna | budi@email.com | password123 |
| Member Frequent Traveller | member@email.com | password123 |
| Manajer Travel | manajer@email.com | password123 |

## Catatan
- Data penerbangan dan akun pada versi ini adalah data contoh yang dibuat otomatis saat
  server pertama kali dijalankan.
- Pengiriman e-tiket disimulasikan dan hanya dicatat di sistem, bukan dikirim ke email
  sungguhan.
- Modul ini berdiri sendiri dan terpisah dari modul monitoring cuti pegawai (HRD).

## Developer
Raven Ravellyn Sulistyo
