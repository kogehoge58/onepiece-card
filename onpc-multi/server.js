'use strict';

/**
 * 複数人で同卓できる Socket.IO サーバ（人数無制限・全員操作可）
 * - ルーム分離: ?room=XXXX で卓を分ける
 * - 初回2名に P1/P2 を割当、それ以降は P3, P4, ... を付番
 * - 途中参加には最新 snapshot を配布
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = normalizePort(process.env.PORT || '3000');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // 開発中は緩め。デプロイ先で整える
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2分まで再接続復元
  },
});

// 画像をBase64でまとめて受けるので上限を拡張
app.use(express.json({ limit: '200mb' }));

const fs   = require('fs');

// 既存の app = express() の後あたりに
app.get('/api/deckbuilt', (req, res) => {
  const base = path.join(__dirname, 'public', 'deck_built');
  fs.readdir(base, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(500).json({ error: String(err) });
    const folders = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => fs.existsSync(path.join(base, name, 'leader.png')));
    res.set('Cache-Control', 'no-store');
    res.json({ folders });
  });
});

// デッキ適用（完全非同期）: { player: 'A'|'B', folder: 'フォルダ名' }
app.post('/api/deck/apply', async (req, res) => {
  try {
    const { player, folder } = req.body || {};
    if (player !== 'A' && player !== 'B') {
      return res.status(400).json({ ok:false, error:'bad player' });
    }
    if (!folder || typeof folder !== 'string') {
      return res.status(400).json({ ok:false, error:'bad folder' });
    }
    // ディレクトリトラバーサル対策
    if (folder.includes('..') || folder.includes('/') || folder.includes('\\')) {
      return res.status(400).json({ ok:false, error:'invalid folder' });
    }

    const base = path.join(__dirname, 'public');
    const srcDir = path.join(base, 'deck_built', folder);
    const srcLeader = path.join(srcDir, 'leader.png');
    const srcImages = path.join(srcDir, 'images');

    if (!fs.existsSync(srcLeader) || !fs.existsSync(srcImages)) {
      return res.status(404).json({ ok:false, error:'source not found' });
    }

    const room = pickRoom(req);
    const dstDir    = path.join(base, 'rooms', room, 'deck', player === 'A' ? 'player_A' : 'player_B');
    const dstLeader = path.join(dstDir, 'leader.png');
    const dstImages = path.join(dstDir, 'images');

    const fsp = fs.promises;
    const rmrf = async (p) => {
      try {
        await fsp.rm(p, { recursive: true, force: true });
      } catch (_) {
        // Nodeが古くrm未対応なら手動削除
        const rmManual = async (pp) => {
          if (!fs.existsSync(pp)) return;
          const st = await fsp.lstat(pp);
          if (st.isDirectory()) {
            const ents = await fsp.readdir(pp);
            for (const name of ents) await rmManual(path.join(pp, name));
            await fsp.rmdir(pp).catch(()=>{});
          } else {
            await fsp.unlink(pp).catch(()=>{});
          }
        };
        await rmManual(p);
      }
    };
    const cpdir = async (src, dst) => {
      if (fsp.cp) { // Node 16.7+
        await fsp.cp(src, dst, { recursive: true });
        return;
      }
      // 互換コピー
      const st = await fsp.stat(src);
      if (st.isDirectory()) {
        await fsp.mkdir(dst, { recursive: true });
        const ents = await fsp.readdir(src, { withFileTypes: true });
        for (const ent of ents) {
          await cpdir(path.join(src, ent.name), path.join(dst, ent.name));
        }
      } else {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
      }
    };

    // 1) 既存削除
    await rmrf(dstImages);
    await fsp.unlink(dstLeader).catch(()=>{});

    // 2) コピー配備
    await fsp.mkdir(dstDir, { recursive: true });
    await cpdir(srcImages, dstImages);
    await fsp.copyFile(srcLeader, dstLeader);

    // 3) 完了
    res.set('Cache-Control','no-store');
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// ★カスタムアップロード＆即時適用
// 受信: { player:'A'|'B', files:[{path:'leader.png' or 'images/xxx', contentBase64:'...'}] }
app.post('/api/deck/upload-and-apply', async (req, res) => {
  try {
    const { player, files } = req.body || {};
    if (player !== 'A' && player !== 'B') {
      return res.status(400).json({ ok:false, error:'bad player' });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok:false, error:'no files' });
    }

    const fsp = fs.promises;
    const base = path.join(__dirname, 'public');
    const tmpDir = path.join(base, 'uploads', String(Date.now()));
    const rmrf = async (p) => {
      try { await fsp.rm(p, { recursive:true, force:true }); }
      catch { /* ignore */ }
    };
    const cpdir = async (src, dst) => {
      if (fsp.cp) return fsp.cp(src, dst, { recursive:true });
      const st = await fsp.stat(src);
      if (st.isDirectory()){
        await fsp.mkdir(dst, { recursive:true });
        for (const ent of await fsp.readdir(src, { withFileTypes:true })){
          await cpdir(path.join(src, ent.name), path.join(dst, ent.name));
        }
      } else {
        await fsp.mkdir(path.dirname(dst), { recursive:true });
        await fsp.copyFile(src, dst);
      }
    };

    // 1) 一時領域へ書き出し（leader.png と images/ のみ許可）
    let hasLeader = false, imgCount = 0;
    for (const it of files){
      let rel = String(it.path || '').replace(/\\/g,'/').replace(/^\/+/, '');
      const low = rel.toLowerCase();
      if (low !== 'leader.png' && !low.startsWith('images/')) continue; // ホワイトリスト
      const buf = Buffer.from(String(it.contentBase64 || ''), 'base64');
      const out = path.join(tmpDir, rel);
      await fsp.mkdir(path.dirname(out), { recursive:true });
      await fsp.writeFile(out, buf);
      if (low === 'leader.png') hasLeader = true; else imgCount++;
    }
    if (!hasLeader || imgCount === 0) {
      await rmrf(tmpDir);
      return res.status(400).json({ ok:false, error:'invalid structure (need leader.png and images/*)' });
    }

    // 2) 既存プレイヤーデッキを掃除→配備（/api/deck/apply と同等）
    const room = pickRoom(req);
    const dstDir    = path.join(base, 'rooms', room, 'deck', player === 'A' ? 'player_A' : 'player_B');
    const dstLeader = path.join(dstDir, 'leader.png');
    const dstImages = path.join(dstDir, 'images');
    await rmrf(dstImages);
    await fsp.unlink(dstLeader).catch(()=>{});
    await fsp.mkdir(dstDir, { recursive:true });
    await cpdir(path.join(tmpDir, 'images'), dstImages);
    await fsp.copyFile(path.join(tmpDir, 'leader.png'), dstLeader);

    // 3) 掃除して完了
    await rmrf(tmpDir);
    res.set('Cache-Control','no-store');
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

function pickRoom(req){
  // ?room= があればそれ、無ければ Referer のクエリから拾う
  const url = new URL(req.headers.referer || 'http://x/?room=dev');
  const fromRef = url.searchParams.get('room');
  const q = (req.query && req.query.room) || fromRef || 'dev';
  // ルーム名をサニタイズ（英数-_のみ）
  return String(q).replace(/[^\w-]/g, '_');
}

app.get(/^\/deck\/(.+)$/, (req, res) => {
  const rel = req.params[0];              // player_A/leader.png など
  const room = pickRoom(req);
  const base = path.join(__dirname, 'public');

  const roomFile = path.join(base, 'rooms', room, 'deck', rel);
  const globalFile = path.join(base, 'deck', rel); // フォールバック（従来）

  res.set('Cache-Control','public, max-age=31536000, immutable');
  if (fs.existsSync(roomFile)) return res.sendFile(roomFile);
  return res.sendFile(globalFile);
});

// 静的配信: /public をドキュメントルートに
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.type('text').send('ok'));

// 例: /public の配信を超強めキャッシュ
app.use('/public', express.static('public', {
  maxAge: '365d',
  immutable: true,
  etag: false, // ETag を外して If-None-Match の往復をなくす（運用方針次第）
}));

// roomId -> { roster: Map<socketId,{name,role,seat}>, state:any|null }
const roomState = new Map();

io.on('connection', (socket) => {
  const { room = 'dev', name = 'anon' } = socket.handshake.query || {};
  const roomId = String(room);

  if (!roomState.has(roomId)) roomState.set(roomId, createRoomInfo());
  const info = roomState.get(roomId);

  // --- 席割り（P1/P2 以降は P3, P4, ...） ---
  const used = new Set(Array.from(info.roster.values()).map(p => p.seat));
  let seat = !used.has('P1') ? 'P1' : (!used.has('P2') ? 'P2' : `P${info.roster.size + 1}`);
  const role = 'PLAYER'; // 全員プレイヤー扱い

  // --- 入室 & 名簿 ---
  socket.join(roomId);
  info.roster.set(socket.id, { name: String(name || 'anon'), role, seat });

  socket.emit('room:hello', { room: roomId, name, role, seat });
  publishRoster(roomId, info);

  // --- 途中参加にスナップショットを配布 ---
  if (info.state) socket.emit('snapshot:apply', info.state);

  // --- 操作（アクション）: 全員許可 ---
  socket.on('action', (payload = {}, ack) => {
    const enriched = { ...payload, _from: socket.id, _ts: Date.now() };
    io.to(roomId).emit('action', enriched);
    if (ack) ack({ ok: true });
  });

  // --- 盤面スナップショット: 全員から受け付け、保持＆配信 ---
  socket.on('snapshot:push', (state) => {
    info.state = state;
    socket.to(roomId).emit('snapshot:apply', state);
  });

  // --- 明示要求: 現在のスナップショットを返す ---
  socket.on('snapshot:pull', () => {
    if (info.state) socket.emit('snapshot:apply', info.state);
  });

  // --- ブラウザ更新ブロードキャスト（送信者以外に通知） ---
  // クライアントが「自分はリロードした」と申告 → 同室の他クライアントへ一斉通知
  socket.on('client:request-room-reload', () => {
    socket.to(roomId).emit('room:reload', { by: socket.id, ts: Date.now() });
  });

  // --- 退室 ---
  socket.on('disconnect', () => {
    const r = roomState.get(roomId);
    if (!r) return;
    r.roster.delete(socket.id);
    publishRoster(roomId, r);
    if (r.roster.size === 0) roomState.delete(roomId); // 無人なら掃除
  });
});

server.listen(PORT, () => {
  console.log(`→ http://localhost:${PORT}`);
});

/* ================= ヘルパ ================= */
function createRoomInfo() {
  return { roster: new Map(), state: null };
}
function publishRoster(roomId, info) {
  const list = [...info.roster.entries()].map(([id, p]) => ({ id, name: p.name, role: p.role, seat: p.seat }));
  io.to(roomId).emit('room:roster', list);
}
function normalizePort(val) {
  const port = parseInt(val, 10);
  if (Number.isNaN(port)) return val;
  if (port >= 0) return port;
  return 3000;
}
