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
