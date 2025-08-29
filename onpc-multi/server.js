'use strict';

/**
 * 2人対戦（P1/P2）＋観戦(SPEC*)に対応した Socket.IO サーバ
 * - ルーム分離: ?room=XXXX で同卓を分ける
 * - 観戦: ?role=spec で観戦入室 / プレイヤー満席時は自動で観戦にフォールバック
 * - 操作: PLAYER のみ 'action' を送信可能（SPEC は拒否）
 * - 途中参加: サーバ保持の snapshot を 'snapshot:apply' で即配布
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = normalizePort(process.env.PORT || '3000');
const MAX_PLAYERS = 2;
const MAX_SPECTATORS = process.env.MAX_SPECTATORS ? Number(process.env.MAX_SPECTATORS) : Infinity;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // 開発中は緩め。デプロイ先で整える
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2分まで再接続復元
  },
});

app.use(express.json());

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

    const dstDir = path.join(base, 'deck', player === 'A' ? 'player_A' : 'player_B');
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

// 静的配信: /public をドキュメントルートに
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.type('text').send('ok'));

// roomId -> { roster: Map<socketId,{name,role,seat}>, state:any|null, nextSpecNo:number }
const roomState = new Map();

io.on('connection', (socket) => {
  const { room = 'dev', name = 'anon', role: requestedRole } = socket.handshake.query || {};
  const roomId = String(room);

  if (!roomState.has(roomId)) roomState.set(roomId, createRoomInfo());
  const info = roomState.get(roomId);

  // --- 役割決定 ---
  const currentPlayers = getPlayers(info);
  let role = 'PLAYER';
  if (requestedRole === 'spec' || currentPlayers.length >= MAX_PLAYERS) {
    role = 'SPEC';
  }

  // 観戦上限
  if (role === 'SPEC' && countSpectators(info) >= MAX_SPECTATORS) {
    socket.emit('room:spectators_full', { room: roomId });
    return socket.disconnect(true);
  }

  // --- 席割り ---
  let seat;
  if (role === 'PLAYER') {
    const used = new Set(currentPlayers.map(p => p.seat));
    seat = used.has('P1') ? 'P2' : 'P1';
  } else {
    seat = `SPEC${info.nextSpecNo++}`;
  }

  // --- 入室 & 名簿 ---
  socket.join(roomId);
  info.roster.set(socket.id, { name: String(name || 'anon'), role, seat });

  socket.emit('room:hello', { room: roomId, name, role, seat });
  publishRoster(roomId, info);

  // --- 途中参加にスナップショットを配布 ---
  if (info.state) socket.emit('snapshot:apply', info.state);

  // --- 操作（アクション）: 観戦は拒否 ---
  socket.on('action', (payload = {}, ack) => {
    const me = info.roster.get(socket.id);
    if (!me || me.role !== 'PLAYER') {
      if (ack) ack({ ok: false, reason: 'spectator' });
      return;
    }
    const enriched = { ...payload, _from: socket.id, _ts: Date.now() };
    io.to(roomId).emit('action', enriched);
    if (ack) ack({ ok: true });
  });

  // --- 盤面スナップショット: PLAYERのみ受け付け、保持＆配信 ---
  socket.on('snapshot:push', (state) => {
    const me = info.roster.get(socket.id);
    if (!me || me.role !== 'PLAYER') return; // 観戦からのpushは無視
    info.state = state;
    socket.to(roomId).emit('snapshot:apply', state);
  });

  // --- 明示要求: 現在のスナップショットを返す ---
  socket.on('snapshot:pull', () => {
    if (info.state) socket.emit('snapshot:apply', info.state);
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
  return { roster: new Map(), state: null, nextSpecNo: 1 };
}
function getPlayers(info) {
  return [...info.roster.values()].filter(p => p.role === 'PLAYER');
}
function countSpectators(info) {
  return [...info.roster.values()].filter(p => p.role === 'SPEC').length;
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
