const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

const PORT = 3000;
const IP_LAPTOP = "192.168.140.45";
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzGbqVnAZreFC6Fz2dCg4UIJJv4a4fjuYI9J3VNTEwGFN-lmUOP5-ODl4SboUyvAS27Sw/exec';
const CAPTURE_DIR = path.join(__dirname, 'captures');
const TEMPLATE_PATH = path.join(__dirname, 'frame_template.png');

if (!fs.existsSync(CAPTURE_DIR)) {
  fs.mkdirSync(CAPTURE_DIR);
}

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let activeSession = {
  kupon: 'SESI',
  nama: 'Peserta',
  sessionDir: null,
  photos: []
};

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createSessionFolder(kupon, nama) {
  const now = new Date();
  const timeStr = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');

  const safeKupon = String(kupon || 'SESI').trim().toUpperCase().replace(/[\\/:*?"<>|]/g, '_');
  const safeNama = String(nama || 'Peserta').trim().replace(/[\\/:*?"<>|]/g, '_');

  const folderName = `${safeKupon} - ${safeNama} (${timeStr})`;
  const fullPath = path.join(CAPTURE_DIR, folderName);

  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
  return fullPath;
}

async function postToGAS(payloadObj) {
  const payloadString = JSON.stringify(payloadObj);

  const postRes = await axios.post(GAS_WEB_APP_URL, payloadString, {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400
  });

  if (postRes.status === 302 && postRes.headers.location) {
    const getRes = await axios.get(postRes.headers.location);
    return getRes.data;
  }

  return postRes.data;
}

async function buildPhotoStrip(photoBuffers) {
  const stripWidth = 1200;
  const stripHeight = 3000;
  const slotW = 1040;
  const slotH = 780;

  for (let i = 0; i < 3; i++) {
    if (!photoBuffers[i]) {
      throw new Error(`Foto pose ke-${i + 1} belum tersimpan di server. Silakan ulangi sesi dari awal.`);
    }
  }

  // 1. Ubah ukuran 3 foto peserta agar pas dengan slot bingkai (1040 x 780 px)
  const resizedPoses = await Promise.all(
    [photoBuffers[0], photoBuffers[1], photoBuffers[2]].map(buf =>
      sharp(buf).resize(slotW, slotH, { fit: 'cover' }).toBuffer()
    )
  );

  // 2. Susun lapisan dasar (Foto 1, Foto 2, Foto 3)
  const layers = [
    { input: resizedPoses[0], left: 80, top: 80 },
    { input: resizedPoses[1], left: 80, top: 940 },
    { input: resizedPoses[2], left: 80, top: 1800 }
  ];

  // 3. Timpa dengan desain kustom frame_template.png (jika tersedia), atau gunakan teks default
  if (fs.existsSync(TEMPLATE_PATH)) {
    const templateBuffer = await sharp(TEMPLATE_PATH)
      .resize(stripWidth, stripHeight)
      .toBuffer();

    layers.push({ input: templateBuffer, left: 0, top: 0 });
  } else {
    const safeKupon = escapeXml(activeSession.kupon || 'SESI');
    const safeNama = escapeXml(activeSession.nama || 'Peserta');

    const fallbackFooterSvg = Buffer.from(`
      <svg width="${stripWidth}" height="${stripHeight}">
        <rect width="100%" height="100%" fill="none"/>
        <text x="50%" y="2770" font-family="sans-serif" font-size="54" font-weight="bold" fill="#0f172a" text-anchor="middle">
          PHOTOBOOTH EVENT 2026
        </text>
        <text x="50%" y="2850" font-family="sans-serif" font-size="36" fill="#64748b" text-anchor="middle">
          ${safeKupon} • ${safeNama}
        </text>
      </svg>
    `);

    layers.push({ input: fallbackFooterSvg, left: 0, top: 0 });
  }

  // 4. Gabungkan seluruh lapisan menjadi file JPEG resolusi penuh
  return await sharp({
    create: {
      width: stripWidth,
      height: stripHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .composite(layers)
    .jpeg({ quality: 88 })
    .toBuffer();
}

io.on('connection', (socket) => {
  // Jalur Signaling WebRTC
  socket.on('KIOSK_READY_FOR_STREAM', () => socket.broadcast.emit('KIOSK_READY_FOR_STREAM'));
  socket.on('WEBRTC_OFFER', (offer) => socket.broadcast.emit('WEBRTC_OFFER', offer));
  socket.on('WEBRTC_ANSWER', (answer) => socket.broadcast.emit('WEBRTC_ANSWER', answer));
  socket.on('WEBRTC_ICE', (candidate) => socket.broadcast.emit('WEBRTC_ICE', candidate));

  // Manajemen Sesi & Jepret
  socket.on('INIT_DUMMY_SESSION', ({ kupon, nama }) => {
    const sessionDir = createSessionFolder(kupon, nama);
    activeSession = { kupon, nama, sessionDir, photos: [] };
    console.log(`Sesi baru dimulai -> Folder lokal: ${sessionDir}`);
  });

  socket.on('TRIGGER_SHUTTER', (poseIndex) => {
    io.emit('CAPTURE_NOW', poseIndex);
  });

  socket.on('PHOTO_CAPTURED', ({ poseIndex, base64Image }) => {
    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    if (!activeSession.sessionDir) {
      activeSession.sessionDir = createSessionFolder(activeSession.kupon, activeSession.nama);
    }

    const fileName = `Pose_${poseIndex + 1}.jpg`;
    fs.writeFileSync(path.join(activeSession.sessionDir, fileName), buffer);

    activeSession.photos[poseIndex] = buffer;
    console.log(`Tersimpan: ${fileName} di ${path.basename(activeSession.sessionDir)}`);

    io.emit('PREVIEW_READY', { poseIndex, base64Image });
  });

  socket.on('FINALIZE_AND_UPLOAD', async () => {
    try {
      io.emit('UPLOAD_STATUS', 'Menyusun frame foto di server lokal...');
      const stripBuffer = await buildPhotoStrip(activeSession.photos);

      if (!activeSession.sessionDir) {
        activeSession.sessionDir = createSessionFolder(activeSession.kupon, activeSession.nama);
      }

      fs.writeFileSync(path.join(activeSession.sessionDir, '00_PhotoStrip_Final.jpg'), stripBuffer);

      io.emit('UPLOAD_STATUS', 'Mengompres & mengunggah ke Google Drive...');

      const validPhotos = [activeSession.photos[0], activeSession.photos[1], activeSession.photos[2]];
      const compressedPoses = await Promise.all(
        validPhotos.map((buf, idx) =>
          sharp(buf)
            .resize(960, 720, { fit: 'inside' })
            .jpeg({ quality: 75 })
            .toBuffer()
            .then(smallBuf => ({
              fileName: `Pose_${idx + 1}.jpg`,
              mimeType: 'image/jpeg',
              base64Data: smallBuf.toString('base64')
            }))
        )
      );

      // Kompres ringan strip final khusus untuk payload upload agar tetap cepat (< 500 KB)
      const compressedStrip = await sharp(stripBuffer)
        .resize(800, 2000, { fit: 'inside' })
        .jpeg({ quality: 82 })
        .toBuffer();

      const filesPayload = [
        {
          fileName: '00_PhotoStrip_Final.jpg',
          mimeType: 'image/jpeg',
          base64Data: compressedStrip.toString('base64')
        },
        ...compressedPoses
      ];

      console.log('Mengunggah ke Google Apps Script...');

      const result = await postToGAS({
        action: 'upload',
        kupon: activeSession.kupon || 'SESI',
        nama: activeSession.nama || 'Peserta',
        files: filesPayload
      });

      if (result && result.status === 'success') {
        console.log('Berhasil upload ke GDrive:', result.folderUrl);
        io.emit('SESSION_COMPLETED', {
          folderUrl: result.folderUrl,
          stripBase64: 'data:image/jpeg;base64,' + compressedStrip.toString('base64')
        });
      } else {
        console.error('Respon tidak terduga dari GAS:', typeof result === 'string' ? result.slice(0, 500) : result);
        io.emit('UPLOAD_ERROR', (result && result.message) || 'Gagal upload ke Drive (cek log terminal)');
      }
    } catch (err) {
      console.error('Error saat upload:', err.message);
      io.emit('UPLOAD_ERROR', err.message);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server Photobooth berjalan di http://localhost:${PORT}`);
  console.log(`1. Buka di Laptop (Kamera): http://localhost:${PORT}/camera.html`);
  console.log(`2. Buka di HP/iPad (Kiosk): http://${IP_LAPTOP}:${PORT}/kiosk.html`);
});