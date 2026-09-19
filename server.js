// ============================================
// ع السريع - سيرفر Socket.io
// إصلاح كامل لمشكلة "الغرفة غير موجودة"
// ============================================
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

// ═══════════════════════════════════════════════════
// 1. خريطة الأقسام (إنجليزي + عربي)
// ═══════════════════════════════════════════════════
const RAW_CATEGORY_MAP = {
  'football': 'football.json',
  'كرة القدم': 'football.json', 'كرة قدم': 'football.json',
  'كوره القدم': 'football.json', 'كوره قدم': 'football.json',

  'general': 'general.json',
  'معلومات عامة': 'general.json', 'معلومات عامه': 'general.json', 'معلومات': 'general.json',

  'anime': 'anime.json',
  'أنمي': 'anime.json', 'انمي': 'anime.json',
  'أنيمي': 'anime.json', 'انيمي': 'anime.json',

  'islamic': 'islamic.json',
  'إسلاميات': 'islamic.json', 'اسلاميات': 'islamic.json',
  'إسلامي': 'islamic.json', 'اسلامي': 'islamic.json'
};

const CATEGORY_MAP = {};
for (const [key, value] of Object.entries(RAW_CATEGORY_MAP)) {
  CATEGORY_MAP[key.trim().toLowerCase().replace(/\s+/g, ' ')] = value;
}
const UNIQUE_FILES = [...new Set(Object.values(CATEGORY_MAP))];

function normalizeCategory(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

const CATEGORY_DISPLAY = {
  'football.json': { key: 'football', nameAr: 'كرة القدم',    icon: '⚽' },
  'general.json':  { key: 'general',  nameAr: 'معلومات عامة', icon: '🧠' },
  'anime.json':    { key: 'anime',    nameAr: 'أنمي',         icon: '🎌' },
  'islamic.json':  { key: 'islamic',  nameAr: 'إسلاميات',     icon: '🕌' }
};

// ═══════════════════════════════════════════════════
// 2. تحميل بنك الأسئلة
// ═══════════════════════════════════════════════════
const QUESTION_BANK = {};

function loadQuestions() {
  console.log('\n═══════════════════════════════════════════');
  console.log('📚 تحميل بنك الأسئلة');
  console.log('📂', __dirname);
  console.log('═══════════════════════════════════════════');

  UNIQUE_FILES.forEach((filename) => {
    const fullPath = path.resolve(__dirname, filename);
    console.log(`\n🔍 [${filename}] → ${fullPath}`);

    if (!fs.existsSync(fullPath)) {
      console.error(`   ❌ الملف غير موجود`);
      QUESTION_BANK[filename] = [];
      return;
    }
    let raw;
    try { raw = fs.readFileSync(fullPath, 'utf8'); }
    catch (e) { console.error(`   ❌ قراءة: ${e.message}`); QUESTION_BANK[filename] = []; return; }

    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { console.error(`   ❌ JSON: ${e.message}`); QUESTION_BANK[filename] = []; return; }

    if (!Array.isArray(parsed)) { console.error(`   ❌ ليس مصفوفة`); QUESTION_BANK[filename] = []; return; }

    const valid = [];
    let legacy = 0, rejected = 0;
    parsed.forEach((q) => {
      if (!q || typeof q !== 'object') { rejected++; return; }
      if (('id' in q || 'name' in q) && !('question' in q) && !('q' in q)) { legacy++; return; }
      const text = q.question ?? q.q;
      const choices = q.choices ?? q.c;
      const idx = q.correct_index ?? q.a;
      if (typeof text !== 'string' || !text.trim()) { rejected++; return; }
      if (!Array.isArray(choices) || choices.length !== 4) { rejected++; return; }
      if (typeof idx !== 'number' || idx < 0 || idx > 3) { rejected++; return; }
      valid.push({ question: text.trim(), choices: choices.map(String), correct_index: idx });
    });
    QUESTION_BANK[filename] = valid;
    console.log(`   ✅ صالحة: ${valid.length}${legacy ? ` | 🚨 قديمة: ${legacy}` : ''}${rejected ? ` | مرفوضة: ${rejected}` : ''}`);
  });

  console.log('\n📊 ملخص بنك الأسئلة:');
  Object.entries(QUESTION_BANK).forEach(([f, arr]) => {
    const m = CATEGORY_DISPLAY[f];
    console.log(`   ${arr.length > 0 ? '✅' : '❌'} ${m ? m.nameAr : f} → ${arr.length} سؤال`);
  });
  console.log('');
}
loadQuestions();

// ═══════════════════════════════════════════════════
// 3. أدوات مساعدة
// ═══════════════════════════════════════════════════
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shuffleQuestionChoices(q) {
  const indexed = q.choices.map((choice, idx) => ({ choice, isCorrect: idx === q.correct_index }));
  const shuffled = shuffleArray(indexed);
  const newCorrectIndex = shuffled.findIndex(item => item.isCorrect);
  return { question: q.question, choices: shuffled.map(i => i.choice), correct_index: newCorrectIndex };
}

// ═══════════════════════════════════════════════════
// 4. تخزين الغرف — Object مع مفاتيح String دائماً
// ═══════════════════════════════════════════════════
const rooms = {};   // ⚠️ المفاتيح دائماً String

// توليد كود فريد (String دائماً)
function generateRoomCode() {
  let code;
  let attempts = 0;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
    if (attempts > 500) break;
  } while (rooms[code]);   // rooms[code] بمفتاح String
  return code;
}

// تطبيع كود الغرفة القادم من العميل → String نظيف
function normalizeRoomCode(raw) {
  if (raw == null) return '';
  // نحوّله لـ String، ونزيل أي مسافات أو رموز
  return String(raw).trim().replace(/\s+/g, '');
}

// طباعة قائمة الغرف المفتوحة (للـ debugging)
function logOpenRooms(context) {
  const codes = Object.keys(rooms);
  console.log('\n📋 ───── الغرف المفتوحة حالياً ─────');
  if (codes.length === 0) {
    console.log('   (لا توجد غرف مفتوحة)');
  } else {
    codes.forEach((code) => {
      const r = rooms[code];
      const players = r.players.map(p => p.name).join(', ') || '(لا لاعبين)';
      const isStarted = (r.state === 'playing' || r.state === 'reveal');
      console.log(`   🏠 ${code} | الحالة: ${r.state} | بدأت: ${isStarted ? 'نعم' : 'لا'} | اللاعبون (${r.players.length}/4): ${players} | القسم: ${r.categoryKey || '(لم يُختر)'}`);
    });
  }
  if (context) console.log(`   📌 السياق: ${context}`);
  console.log('   ─────────────────────────────────\n');
}

// ═══════════════════════════════════════════════════
// 5. ثوابت اللعبة
// ═══════════════════════════════════════════════════
const CONSTANTS = {
  TARGET_SCORE: 10,
  MAX_PLAYERS: 4,
  MIN_PLAYERS: 2,
  NEXT_QUESTION_DELAY: 1500,
  REVEAL_DELAY: 2200
};

// حالات الغرفة التي تسمح بالانضمام (لم تبدأ اللعبة فعلاً)
const JOINABLE_STATES = new Set(['lobby', 'category']);

// ═══════════════════════════════════════════════════
// 6. إنشاء غرفة جديدة
// ═══════════════════════════════════════════════════
function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,                              // String دائماً
    hostId: hostSocketId,
    players: [],

    // ⚠️ isStarted = false دائماً عند الإنشاء
    // لا يتغيّر إلى true إلا في start_game
    isStarted: false,

    // state للتوافق مع الكود القديم:
    //   'lobby'    → لم تُبدأ، انضمام مسموح
    //   'category' → قسم مختار لكن لم تُبدأ، انضمام مسموح
    //   'playing'  → بدأت فعلاً، انضمام مرفوض
    //   'reveal'   → جاري كشف إجابة، انضمام مرفوض
    //   'finished' → انتهت، انضمام مرفوض
    state: 'lobby',

    category: null,                    // اسم الملف (football.json)
    categoryKey: null,                 // المفتاح الإنجليزي (football)

    questionPool: [],
    questionIndex: -1,
    currentQuestion: null,
    removedChoices: new Set(),
    lastCorrectIndex: null,
    roundWinner: null,
    advanceTimer: null
  };
  rooms[code] = room;
  return room;
}

function getPublicRoom(room) {
  const meta = room.category ? CATEGORY_DISPLAY[room.category] : null;
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    isStarted: room.isStarted,
    category: room.categoryKey,
    categoryMeta: meta,
    players: room.players.map(p => ({
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      locked: p.lockedThisRound,
      connected: p.connected
    })),
    targetScore: CONSTANTS.TARGET_SCORE,
    questionNumber: room.questionIndex + 1,
    removedChoices: Array.from(room.removedChoices)
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', getPublicRoom(room));
}

// ═══════════════════════════════════════════════════
// 7. منطق الأسئلة
// ═══════════════════════════════════════════════════
function pickNextQuestion(room) {
  if (room.questionIndex + 1 >= room.questionPool.length) {
    const fresh = QUESTION_BANK[room.category] || [];
    room.questionPool = shuffleArray(fresh).map(shuffleQuestionChoices);
    room.questionIndex = -1;
    console.log(`🔁 [${room.code}] إعادة خلط بنك الأسئلة`);
  }
  room.questionIndex++;
  return room.questionPool[room.questionIndex];
}

function sendNextQuestion(room) {
  if (room.state === 'finished') return;

  const winner = room.players.find(p => p.score >= CONSTANTS.TARGET_SCORE);
  if (winner) return endGame(room, winner);

  const q = pickNextQuestion(room);
  if (!q) return endGame(room, null);

  room.currentQuestion = q;
  room.removedChoices = new Set();
  room.lastCorrectIndex = null;
  room.roundWinner = null;
  room.players.forEach(p => { p.lockedThisRound = false; });
  room.state = 'playing';

  io.to(room.code).emit('new_question', {
    index: room.questionIndex,
    question: q.question,
    choices: q.choices,
    targetScore: CONSTANTS.TARGET_SCORE,
    players: room.players.map(p => ({ name: p.name, avatar: p.avatar, score: p.score, locked: false }))
  });
  broadcastRoom(room);
}

function endGame(room, winner) {
  if (room.state === 'finished') return;
  room.state = 'finished';
  clearTimeout(room.advanceTimer);
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  io.to(room.code).emit('game_over', {
    winnerName: winner ? winner.name : null,
    reason: winner ? `${winner.name} وصل إلى ${CONSTANTS.TARGET_SCORE} نقاط` : 'انتهت الأسئلة',
    rankings: sorted.map((p, i) => ({
      rank: i + 1, name: p.name, avatar: p.avatar, score: p.score
    }))
  });
  broadcastRoom(room);
  console.log(`🏆 [${room.code}] انتهت اللعبة — الفائز: ${winner ? winner.name : 'لا أحد'}`);
}

// ═══════════════════════════════════════════════════
// 8. Socket.io — الأحداث الرئيسية
// ═══════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`\n🔌 اتصال جديد: ${socket.id}`);

  // ═══════════════════════════════════════════════════
  // CREATE ROOM
  // ═══════════════════════════════════════════════════
  socket.on('create_room', ({ name, avatar }) => {
    if (!name || !name.trim()) {
      return socket.emit('error_msg', { msg: 'اكتب اسمك أولاً!' });
    }

    const room = createRoom(socket.id);
    room.players.push({
      socketId: socket.id,
      name: name.trim().slice(0, 15),
      avatar: avatar || '🎮',
      score: 0,
      lockedThisRound: false,
      connected: true
    });

    socket.join(room.code);
    socket.data.roomCode = room.code;

    console.log(`🏠 [${room.code}] تم إنشاء الغرفة بواسطة "${name.trim()}"`);
    socket.emit('room_created', { code: room.code });
    broadcastRoom(room);
    logOpenRooms('بعد إنشاء غرفة');
  });

  // ═══════════════════════════════════════════════════
  // JOIN ROOM — مُصلَّح نهائياً
  // ═══════════════════════════════════════════════════
  socket.on('join_room', ({ code, name, avatar }) => {
    // 1) التحقق من المدخلات
    if (!name || !name.trim()) {
      return socket.emit('error_msg', { msg: 'اكتب اسمك!' });
    }

    // 2) ⚠️ تطبيع الكود → String دائماً
    const roomCode = normalizeRoomCode(code);

    console.log(`\n🚪 محاولة انضمام:`);
    console.log(`   ├─ الاسم: "${name.trim()}"`);
    console.log(`   ├─ الكود الخام: ${JSON.stringify(code)} (النوع: ${typeof code})`);
    console.log(`   ├─ بعد التطبيع: "${roomCode}" (النوع: ${typeof roomCode})`);
    console.log(`   └─ الغرف المتاحة حالياً: [${Object.keys(rooms).join(', ') || 'لا يوجد'}]`);

    if (!roomCode) {
      console.log(`   ❌ كود فارغ`);
      return socket.emit('error_msg', { msg: 'اكتب كود الغرفة!' });
    }

    // 3) البحث عن الغرفة (المفتاح String دائماً)
    const room = rooms[roomCode];
    if (!room) {
      console.log(`   ❌ الغرفة "${roomCode}" غير موجودة!`);
      logOpenRooms('فشل الانضمام');
      return socket.emit('error_msg', { msg: `الغرفة "${roomCode}" غير موجودة! تأكد من الكود.` });
    }

    console.log(`   ✅ الغرفة موجودة — الحالة: ${room.state} | isStarted: ${room.isStarted} | عدد اللاعبين: ${room.players.length}`);

    // 4) التحقق من أن اللعبة لم تبدأ فعلاً
    if (room.isStarted || !JOINABLE_STATES.has(room.state)) {
      console.log(`   ❌ اللعبة بدأت بالفعل`);
      return socket.emit('error_msg', { msg: 'اللعبة بدأت بالفعل! انتظر الجولة القادمة.' });
    }

    // 5) التحقق من السعة
    if (room.players.length >= CONSTANTS.MAX_PLAYERS) {
      console.log(`   ❌ الغرفة ممتلئة`);
      return socket.emit('error_msg', { msg: `الغرفة ممتلئة (${CONSTANTS.MAX_PLAYERS} لاعبين بحد أقصى)!` });
    }

    // 6) التحقق من تكرار الاسم
    const cleanName = name.trim().slice(0, 15);
    if (room.players.some(p => p.name === cleanName)) {
      console.log(`   ❌ الاسم مستخدم`);
      return socket.emit('error_msg', { msg: 'هذا الاسم مستخدم بالفعل!' });
    }

    // 7) الانضمام الناجح
    room.players.push({
      socketId: socket.id,
      name: cleanName,
      avatar: avatar || '🎮',
      score: 0,
      lockedThisRound: false,
      connected: true
    });

    socket.join(room.code);
    socket.data.roomCode = room.code;

    console.log(`   ✅ تم الانضمام! عدد اللاعبين الآن: ${room.players.length}`);
    socket.emit('room_joined', { code: room.code });
    broadcastRoom(room);
    logOpenRooms('بعد انضمام ناجح');
  });

  // ═══════════════════════════════════════════════════
  // SELECT CATEGORY — لا يغيّر isStarted ولا state
  // ═══════════════════════════════════════════════════
  socket.on('select_category', ({ category }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];

    if (!room) {
      console.log(`❌ [select_category] الغرفة غير موجودة: ${roomCode}`);
      return socket.emit('error_msg', { msg: 'الغرفة غير موجودة!' });
    }

    if (room.hostId !== socket.id) {
      return socket.emit('error_msg', { msg: 'فقط المضيف يمكنه اختيار القسم!' });
    }

    // ✅ إذا بدأت اللعبة فعلاً، لا يُسمح بتغيير القسم
    if (room.isStarted || !JOINABLE_STATES.has(room.state)) {
      return socket.emit('error_msg', { msg: 'لا يمكن تغيير القسم بعد بدء اللعبة!' });
    }

    // تطبيع القسم
    const normalized = normalizeCategory(category);
    let filename = CATEGORY_MAP[normalized];
    if (!filename && normalized.endsWith('.json') && UNIQUE_FILES.includes(normalized)) filename = normalized;
    if (!filename && /^[a-z]+$/.test(normalized)) {
      const guess = `${normalized}.json`;
      if (UNIQUE_FILES.includes(guess)) filename = guess;
    }

    if (!filename) {
      console.log(`❌ قسم غير معروف: "${category}"`);
      return socket.emit('error_msg', { msg: `قسم غير معروف: "${category}"` });
    }

    const bank = QUESTION_BANK[filename];
    if (!bank || bank.length === 0) {
      return socket.emit('error_msg', { msg: `لا توجد أسئلة في "${CATEGORY_DISPLAY[filename].nameAr}"` });
    }

    // ✅ فقط نحدّث بيانات القسم — لا نلمس isStarted أو state
    room.category = filename;
    room.categoryKey = CATEGORY_DISPLAY[filename].key;

    console.log(`\n🎯 [${room.code}] المضيف اختار القسم: ${room.categoryKey}`);
    console.log(`   ├─ isStarted (لم يتغير): ${room.isStarted}`);
    console.log(`   └─ state (لم يتغير): ${room.state}`);

    broadcastRoom(room);
  });

  // ═══════════════════════════════════════════════════
  // START GAME — هنا فقط isStarted = true
  // ═══════════════════════════════════════════════════
  socket.on('start_game', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];

    if (!room) {
      console.log(`❌ [start_game] الغرفة غير موجودة: ${roomCode}`);
      return socket.emit('error_msg', { msg: 'الغرفة غير موجودة!' });
    }

    if (room.hostId !== socket.id) {
      return socket.emit('error_msg', { msg: 'فقط المضيف يمكنه بدء اللعبة!' });
    }

    if (room.isStarted) {
      return socket.emit('error_msg', { msg: 'اللعبة بدأت بالفعل!' });
    }

    if (room.players.length < CONSTANTS.MIN_PLAYERS) {
      return socket.emit('error_msg', { msg: `محتاج ${CONSTANTS.MIN_PLAYERS} لاعبين على الأقل!` });
    }

    if (!room.category) {
      return socket.emit('error_msg', { msg: 'اختر القسم أولاً!' });
    }

    const pool = QUESTION_BANK[room.category];
    if (!pool || pool.length === 0) {
      return socket.emit('error_msg', { msg: 'لا توجد أسئلة في هذا القسم!' });
    }

    // تهيئة الأسئلة
    room.questionPool = shuffleArray(pool).map(shuffleQuestionChoices);
    room.questionIndex = -1;
    room.removedChoices = new Set();
    room.players.forEach(p => { p.score = 0; p.lockedThisRound = false; });

    // ✅ الآن فقط: قفل الانضمام
    room.isStarted = true;

    console.log(`\n🎬 [${room.code}] بدء اللعبة`);
    console.log(`   ├─ عدد اللاعبين: ${room.players.length}`);
    console.log(`   ├─ القسم: ${room.categoryKey}`);
    console.log(`   └─ isStarted: ${room.isStarted} (باب الانضمام أُغلق)`);

    io.to(room.code).emit('game_started', {
      category: room.categoryKey,
      categoryMeta: CATEGORY_DISPLAY[room.category],
      targetScore: CONSTANTS.TARGET_SCORE
    });
    broadcastRoom(room);

    setTimeout(() => sendNextQuestion(room), 500);
  });

  // ═══════════════════════════════════════════════════
  // SUBMIT ANSWER
  // ═══════════════════════════════════════════════════
  socket.on('submit_answer', ({ choiceIndex }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || !room.currentQuestion) return;
    if (typeof choiceIndex !== 'number' || choiceIndex < 0 || choiceIndex > 3) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    if (player.lockedThisRound) return;
    if (room.removedChoices.has(choiceIndex)) return;

    const isCorrect = (choiceIndex === room.currentQuestion.correct_index);

    if (isCorrect) {
      player.score += 1;
      player.lockedThisRound = true;
      room.lastCorrectIndex = choiceIndex;
      room.roundWinner = player.name;
      room.state = 'reveal';

      console.log(`✅ [${room.code}] ${player.name} +1 (المجموع: ${player.score})`);

      io.to(room.code).emit('answer_correct', {
        winnerName: player.name,
        winnerSocketId: player.socketId,
        correctIndex: choiceIndex,
        scores: room.players.map(p => ({ name: p.name, avatar: p.avatar, score: p.score }))
      });
      broadcastRoom(room);

      clearTimeout(room.advanceTimer);
      room.advanceTimer = setTimeout(() => {
        if (player.score >= CONSTANTS.TARGET_SCORE) {
          endGame(room, player);
        } else {
          sendNextQuestion(room);
        }
      }, CONSTANTS.NEXT_QUESTION_DELAY);

    } else {
      player.lockedThisRound = true;
      room.removedChoices.add(choiceIndex);

      console.log(`❌ [${room.code}] ${player.name} أخطأ — الخيار ${choiceIndex} محذوف`);

      io.to(room.code).emit('answer_wrong', {
        playerName: player.name,
        playerSocketId: player.socketId,
        choiceIndex,
        removedChoices: Array.from(room.removedChoices),
        lockedPlayers: room.players.filter(p => p.lockedThisRound).map(p => p.name),
        scores: room.players.map(p => ({ name: p.name, avatar: p.avatar, score: p.score }))
      });
      broadcastRoom(room);

      const allLocked = room.players.every(p => p.lockedThisRound);
      if (allLocked) {
        room.state = 'reveal';
        room.lastCorrectIndex = room.currentQuestion.correct_index;
        clearTimeout(room.advanceTimer);
        room.advanceTimer = setTimeout(() => {
          io.to(room.code).emit('round_revealed', {
            correctIndex: room.currentQuestion.correct_index,
            correctAnswer: room.currentQuestion.choices[room.currentQuestion.correct_index],
            noWinner: true
          });
          setTimeout(() => sendNextQuestion(room), 1500);
        }, 600);
      }
    }
  });

  // ═══════════════════════════════════════════════════
  // PLAY AGAIN
  // ═══════════════════════════════════════════════════
  socket.on('play_again', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف!' });
    clearTimeout(room.advanceTimer);

    room.state = 'lobby';
    room.isStarted = false;             // ✅ فتح باب الانضمام
    room.category = null;
    room.categoryKey = null;
    room.questionPool = [];
    room.questionIndex = -1;
    room.currentQuestion = null;
    room.removedChoices = new Set();
    room.players.forEach(p => { p.score = 0; p.lockedThisRound = false; });

    io.to(room.code).emit('room_reset');
    broadcastRoom(room);
    console.log(`🔄 [${room.code}] إعادة اللعبة — isStarted: false`);
    logOpenRooms('بعد إعادة اللعب');
  });

  // ═══════════════════════════════════════════════════
  // DISCONNECT — لا تحذف الغرفة إلا عند خروج آخر لاعب
  // ═══════════════════════════════════════════════════
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms[code];
    if (!room) return;

    const leaving = room.players.find(p => p.socketId === socket.id);
    console.log(`\n🔌 خروج: ${socket.id} (${leaving ? leaving.name : 'غير معروف'}) من الغرفة ${code}`);

    room.players = room.players.filter(p => p.socketId !== socket.id);

    // ✅ لا نحذف الغرفة إلا عند خروج آخر لاعب
    if (room.players.length === 0) {
      clearTimeout(room.advanceTimer);
      delete rooms[code];
      console.log(`🗑️ [${code}] حذف الغرفة (لا يوجد لاعبون)`);
      logOpenRooms('بعد حذف غرفة');
      return;
    }

    // نقل الملكية إذا غادر المضيف
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].socketId;
      io.to(room.code).emit('host_changed', { name: room.players[0].name });
      console.log(`👑 [${code}] المضيف الجديد: ${room.players[0].name}`);
    }

    io.to(room.code).emit('player_left', { name: leaving ? leaving.name : 'لاعب' });

    // معالجة الحالة إذا كانت اللعبة جارية
    if (room.state === 'playing') {
      const remaining = room.players.filter(p => !p.lockedThisRound);
      if (remaining.length === 0) {
        room.state = 'reveal';
        clearTimeout(room.advanceTimer);
        room.advanceTimer = setTimeout(() => sendNextQuestion(room), 1500);
      }
    }

    broadcastRoom(room);
    logOpenRooms('بعد خروج لاعب');
  });
});

// ═══════════════════════════════════════════════════
// 9. تشغيل السيرفر
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎯 ع السريع يعمل على المنفذ ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🎮 الهدف: ${CONSTANTS.TARGET_SCORE} نقاط | بدون تايمر`);
  console.log(`🚪 حالات الانضمام المسموحة: ${[...JOINABLE_STATES].join(', ')}`);
  console.log(`📋 الغرف المتاحة حالياً: (تُطبع عند كل حدث)\n`);
});