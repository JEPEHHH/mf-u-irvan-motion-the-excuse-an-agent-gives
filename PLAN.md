# Rencana Kerja — The Excuse an Agent Gives After It Loses

## Target & Kriteria
- Deliverable: program `program/v1` yang menulis 1 baris teks UTF-8 (1–200 karakter, bukan spasi saja) ke `/output/entry.txt`.
- Fokus 5 kriteria juri (berurutan): (1) alasan agen AI ke manusianya setelah kalah bounty, (2) benar-benar lucu dengan punchline tajam, (3) suara agen dengan logika mesin & deadpan, (4) bisa diucapkan sekali napas tanpa setup panjang, (5) mengakui kekalahan sendiri (tidak menyalahkan manusia/data/pasar).
- Tie-break: ukuran berkas (byte) lebih kecil menang saat seri.

## Rencana Kerja
1. **Eksplorasi & Brainstorming**: Susun beberapa kandidat alasan sesuai 5 kriteria juri, evaluasi pairwise secara internal, lalu pilih 1–2 kandidat terkuat.
2. **Inisialisasi Lisensi & Entrypoint**: Tambahkan `LICENSE` (MIT) dan buat `main.py` untuk menulis teks terpilih ke `/output/entry.txt`.
3. **Iterasi & Penyempurnaan Teks**: Revisi teks di `main.py` (minimal 2 kali penulisan/suntingan untuk memenuhi `thinking_revised`) agar punchline lebih tajam, pas di bawah 200 karakter, dan hemat byte.
4. **Verifikasi Lokal**: Buat dan jalankan `tests/test_entry.py` untuk memvalidasi output (UTF-8, 1 baris, 1–200 karakter, non-whitespace, deterministik).
5. **Dokumentasi & Pre-submit**: Tulis `README.md`, commit tiap milestone, dan siapkan repo untuk `makefun check`.

## Daftar Berkas yang Akan Dibuat
- `PLAN.md` — rencana kerja dan daftar berkas ini.
- `LICENSE` — lisensi MIT (OSI-approved) sesuai aturan kompetisi.
- `main.py` — entrypoint `program/v1` yang menulis alasan ke `/output/entry.txt`.
- `tests/test_entry.py` — pengujian lokal format, panjang, dan encoding output.
- `README.md` — ringkasan entri dan langkah verifikasi lokal.
