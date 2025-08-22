// node server.js で起動 → http://localhost:3000
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const srv = http.createServer(app);
const io  = new Server(srv, { cors: { origin: '*' } });

// 静的配信（手元の index.html 一式を置く）
app.use(express.static('./public')); // ← public/ に index.html 等を置く

// ===== ルーム単位の“唯一の真実（スナップショット）” =====
const makeInitialState = () => ({
  version: 0,
  players: ['A', 'B'],
  // 配列は画像パスでOK（既存実装と親和性高い）
  deckImages: {
    A: Array.from({length:50}, (_,i) => `deck/player_A/images/image (${i+1}).png`),
    B: Array.from({length:50}, (_,i) => `deck/player_B/images/image (${i+1}).png`)
  },
  handImages:  { A: [], B: [] },
  lifeImages:  { A: [], B: [] },
  trashImages: { A: [], B: [] },

  deckCounts:  { A: 50, B: 50 },
  handCounts:  { A: 0,  B: 0  },
  lifeCounts:  { A: 0,  B: 0  },
  trashCounts: { A: 0,  B: 0  },

  donDeck: { A:10, B:10 },
  donAct:  { A:0,  B:0  },
  donRest: { A:0,  B:0  },

  // 盤面系（必要なら拡張）
  chara: { A: [null,null,null,null,null], B: [null,null,null,null,null] },
  stage: { A: null, B: null },
  // ライフの公開状態（表向き管理）：表になっている画像パスの集合
  revealed: { life: { A:new Set(), B:new Set() }, deck: { A:new Set(), B:new Set() } },
});

const rooms = new Map(); // roomId -> state

function getRoom(roomId='game-1'){
  if(!rooms.has(roomId)) rooms.set(roomId, makeInitialState());
  return rooms.get(roomId);
}

function broadcast(roomId){
  const s = getRoom(roomId);
  s.version++;
  // Set は配信できないので配信用に配列へ
  const wire = JSON.parse(JSON.stringify({
    ...s,
    revealed: {
      life: { A:[...s.revealed.life.A], B:[...s.revealed.life.B] },
      deck: { A:[...s.revealed.deck.A], B:[...s.revealed.deck.B] },
    }
  }));
  io.to(roomId).emit('state:update', wire);
}

/* ========= アクション適用 =========
   最初は必要最低限だけでOK。増やしたくなったら case を追加。
*/
function applyAction(state, a){
  const clamp = (x,min,max)=>Math.min(max,Math.max(min,x|0));

  switch(a.type){
    case 'DRAW_TO_HAND': {
      const p=a.player; const deck=state.deckImages[p];
      if(deck.length===0) break;
      const top=deck.shift();
      state.handImages[p].unshift(top);
      state.deckCounts[p]--; state.handCounts[p]++;
      break;
    }
    case 'DECK_TO_LIFE_TOP': {
      const p=a.player; const deck=state.deckImages[p];
      if(deck.length===0) break;
      const top=deck.shift();
      state.lifeImages[p].unshift(top);
      state.deckCounts[p]--; state.lifeCounts[p]++;
      break;
    }
    case 'DECK_TO_TRASH': {
      const p=a.player; const deck=state.deckImages[p];
      if(deck.length===0) break;
      const top=deck.shift();
      state.trashImages[p].unshift(top);
      state.deckCounts[p]--; state.trashCounts[p]++;
      break;
    }
    case 'LIFE_TO_HAND': {
      const p=a.player; const life=state.lifeImages[p];
      if(life.length===0) break;
      const top=life.shift();
      state.handImages[p].unshift(top);
      state.lifeCounts[p]--; state.handCounts[p]++;
      // 表向き管理からは外す
      state.revealed.life[p].delete(top);
      break;
    }
    case 'LIFE_TO_TRASH': {
      const p=a.player; const life=state.lifeImages[p];
      if(life.length===0) break;
      const top=life.shift();
      state.trashImages[p].unshift(top);
      state.lifeCounts[p]--; state.trashCounts[p]++;
      state.revealed.life[p].delete(top);
      break;
    }
    case 'DON_SET': {
      const { player:p, target, value } = a; // target: 'deck'|'act'|'rest'
      const table = target==='deck'?state.donDeck:target==='act'?state.donAct:state.donRest;
      table[p] = clamp(value, 0, 10);
      break;
    }
    case 'SHUFFLE': {
      const arr = a.path.split('.').reduce((o,k)=>o?.[k], state); // 例: 'deckImages.A'
      if(Array.isArray(arr)){
        for(let i=arr.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [arr[i],arr[j]]=[arr[j],arr[i]]; }
      }
      break;
    }
    case 'MULLIGAN': {
      const p=a.player;
      // 手札→デッキ底へ戻す
      while(state.handImages[p].length){
        state.deckImages[p].push(state.handImages[p].shift());
        state.handCounts[p]--; state.deckCounts[p]++;
      }
      // シャッフル
      const deck=state.deckImages[p];
      for(let i=deck.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [deck[i],deck[j]]=[deck[j],deck[i]]; }
      // 5枚ドロー（先頭積み）
      for(let i=0;i<Math.min(5, deck.length); i++){
        const top=deck.shift();
        state.handImages[p].unshift(top);
        state.deckCounts[p]--; state.handCounts[p]++;
      }
      break;
    }
    case 'REFRESH': {
      const p=a.player;
      // レスト解除、ドン/カウンタ調整（必要に応じて簡略化）
      state.donRest[p]=0;
      const move = Math.min(2, state.donDeck[p]);
      state.donDeck[p]-=move;
      state.donAct[p] = clamp(state.donAct[p]+move, 0, 10);
      // 1ドロー
      const deck=state.deckImages[p];
      if(deck.length){
        const top=deck.shift();
        state.handImages[p].unshift(top);
        state.deckCounts[p]--; state.handCounts[p]++;
      }
      break;
    }
    case 'REVEAL_LIFE': {
      const { player:p, cards } = a; // cards: 表にした画像パス配列
      const set = state.revealed.life[p];
      cards.forEach(src=> set.add(src));
      break;
    }
    default: break;
  }
}

io.on('connection', (socket) => {
  const roomId = 'game-1';
  socket.join(roomId);

  // 初期スナップを一発配信
  io.to(socket.id).emit('state:update', (()=> {
    const s = getRoom(roomId);
    const wire = JSON.parse(JSON.stringify({
      ...s,
      revealed: { life:{A:[...s.revealed.life.A],B:[...s.revealed.life.B]},
                 deck:{A:[...s.revealed.deck.A],B:[...s.revealed.deck.B]} }
    }));
    return wire;
  })());

  // クライアントからのアクション
  socket.on('action', (a) => {
    const state = getRoom(roomId);
    applyAction(state, a);
    broadcast(roomId); // ← 毎アクション後に全スナップ配信
  });

  socket.on('disconnect', ()=>{ /* 必要ならクリーンアップ */ });
});

srv.listen(3000, ()=> console.log('http://localhost:3000'));
