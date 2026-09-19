// ============================================
// ع السريع - سيرفر Socket.io
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
// 1. خريطة الأقسام — تدعم الإنجليزية والعربية
//    المفتاح: أي قيمة يرسلها العميل (تُطبَّع لاحقاً)
//    القيمة: اسم ملف الأسئلة الفعلي
// ═══════════════════════════════════════════════════
const RAW_CATEGORY_MAP = {
  // ===== كرة القدم =====
  'football':      'football.json',
  'كرة القدم':     'football.json',
  'كرة قدم':       'football.json',
  'كوره القدم':    'football.json',
  'كوره قدم':      'football.json',
  'foot ball':     'football.json',

  // ===== معلومات عامة =====
  'general':       'general.json',
  'معلومات عامة':  'general.json',
  'معلومات عامه':  'general.json',
  'معلومات':       'general.json',

  // ===== أنمي =====
  'anime':         'anime.json',
  'أنمي':          'anime.json',
  'انمي':          'anime.json',
  'أنيمي':         'anime.json',
  'انيمي':         'anime.json',

  // ===== إسلاميات =====
  'islamic':       'islamic.json',
  'إسلاميات':      'islamic.json',
  'اسلاميات':      'islamic.json',
  'إسلامي':        'islamic.json',
  'اسلامي':        'islamic.json',
  'islam':         'islamic.json'
};

// تبني خريطة مُطبَّعة (lowercase + trim + دمج المسافات)
const CATEGORY_MAP = {};
for (const [key, value] of Object.entries(RAW_CATEGORY_MAP)) {
  const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, ' ');
  CATEGORY_MAP[normalizedKey] = value;
}

// القائمة النهائية للملفات الفريدة لتحميلها
const UNIQUE_FILES = [...new Set(Object.values(CATEGORY_MAP))];

// ═══════════════════════════════════════════════════
// 2. دالة تطبيع قيمة القسم
// ═══════════════════════════════════════════════════
function normalizeCategory(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ═══════════════════════════════════════════════════
// 3. بيانات الأقسام للعرض (أيقونات + أسماء)
// ═══════════════════════════════════════════════════
const CATEGORY_DISPLAY = {
  'football.json': { key: 'football', nameAr: 'كرة القدم',    icon: '⚽' },
  'general.json':  { key: 'general',  nameAr: 'معلومات عامة', icon: '🧠' },
  'anime.json':    { key: 'anime',    nameAr: 'أنمي',         icon: '🎌' },
  'islamic.json':  { key: 'islamic',  nameAr: 'إسلاميات',     icon: '🕌' }
};

// ═══════════════════════════════════════════════════
// 4. تحميل ملفات الأسئلة مع سجل تفصيلي
// ═══════════════════════════════════════════════════
const QUESTION_BANK = {}; // filename → array of questions

function loadQuestions() {
  console.log('\n═══════════════════════════════════════════');
  console.log('📚 بدء تحميل بنك الأسئلة');
  console.log('📂 مجلد المشروع:', __dirname);
  console.log('📄 الملفات المطلوبة:', UNIQUE_FILES.join(', '));
  console.log('═══════════════════════════════════════════');

  UNIQUE_FILES.forEach((filename) => {
    const fullPath = path.resolve(__dirname, filename);

    console.log(`\n🔍 [${filename}] جاري القراءة من:`);
    console.log(`   └─ ${fullPath}`);

    // 1) فحص وجود الملف
    if (!fs.existsSync(fullPath)) {
      console.error(`   ❌ الملف غير موجود!`);
      console.error(`   💡 تأكد أن "${filename}" موجود في نفس مجلد server.js بالضبط`);
      QUESTION_BANK[filename] = [];
      return;
    }

    // 2) قراءة الملف
    let raw;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      console.error(`   ❌ فشل قراءة الملف: ${err.message}`);
      QUESTION_BANK[filename] = [];
      return;
    }

    // 3) إزالة BOM إن وُجد
    if (raw.charCodeAt(0) === 0xFEFF) {
      raw = raw.slice(1);
      console.warn(`   ⚠️ تم إزالة BOM`);
    }

    // 4) تحليل JSON
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`   ❌ خطأ في صياغة JSON: ${err.message}`);
      if (err.message.includes('position')) {
        const m = err.message.match(/position (\d+)/);
        if (m) {
          const pos = parseInt(m[1]);
          const snip = raw.substring(Math.max(0, pos - 50), pos + 50);
          console.error(`   📍 السياق: ...${snip}...`);
        }
      }
      QUESTION_BANK[filename] = [];
      return;
    }

    // 5) التحقق من المصفوفة
    if (!Array.isArray(parsed)) {
      console.error(`   ❌ الملف ليس مصفوفة. النوع: ${typeof parsed}`);
      QUESTION_BANK[filename] = [];
      return;
    }

    console.log(`   ✅ JSON صالح — ${parsed.length} عنصر خام`);

    // 6) فلترة الأسئلة الصحيحة
    const valid = [];
    let legacy = 0, rejected = 0;

    parsed.forEach((q) => {
      if (!q || typeof q !== 'object') { rejected++; return; }

      // كشف صيغة مشروع "التمثيل" { id, name }
      if (('id' in q || 'name' in q) && !('question' in q) && !('q' in q)) {
        legacy++;
        return;
      }

      const questionText = q.question ?? q.q;
      const choicesArr   = q.choices  ?? q.c;
      const correctIdx   = q.correct_index ?? q.a;

      if (typeof questionText !== 'string' || questionText.trim() === '') { rejected++; return; }
      if (!Array.isArray(choicesArr) || choicesArr.length !== 4) { rejected++; return; }
      if (typeof correctIdx !== 'number' || correctIdx < 0 || correctIdx > 3) { rejected++; return; }

      valid.push({
        question: questionText.trim(),
        choices: choicesArr.map(c => String(c)),
        correct_index: correctIdx
      });
    });

    QUESTION_BANK[filename] = valid;

    console.log(`   ✅ أسئلة صالحة: ${valid.length}`);
    if (legacy > 0) {
      console.error(`   🚨 ${legacy} عنصر بصيغة قديمة { id, name } — يبدو ملف مشروع التمثيل!`);
    }
    if (rejected > 0) {
      console.warn(`   ⚠️ ${rejected} عنصر مرفوض (صيغة خاطئة)`);
    }
    if (valid.length === 0) {
      console.error(`   ❌❌ لا يوجد أسئلة صالحة في "${filename}"!`);
      console.error(`   💡 المطلوب: [{ "question": "...", "choices": [4 items], "correct_index": 0-3 }]`);
    }
  });

  console.log('\n═══════════════════════════════════════════');
  console.log('📊 ملخص:');
  Object.entries(QUESTION_BANK).forEach(([file, arr]) => {
    const meta = CATEGORY_DISPLAY[file];
    const label = meta ? meta.nameAr : file;
    const icon = arr.length > 0 ? '✅' : '❌';
    console.log(`   ${icon} ${label} (${file}): ${arr.length} سؤال`);
  });
  console.log('═══════════════════════════════════════════\n');
}

loadQuestions();

// ═══════════════════════════════════════════════════
// 5. دوال مساعدة
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
  return {
    question: q.question,
    choices: shuffled.map(item => item.choice),
    correct_index: newCorrectIndex
  };
}

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms[code]);
  return code;
}

function now() { return Date.now(); }

// ═══════════════════════════════════════════════════
// 6. إدارة الغرف
// ═══════════════════════════════════════════════════
const rooms = {};

const CONSTANTS = {
  QUESTIONS_PER_GAME: 10,
  QUESTION_TIME: 15,
  REVEAL_TIME: 4,
  BASE_SCORE: 500,
  MAX_SPEED_BONUS: 500,
  MAX_PLAYERS: 4,
  MIN_PLAYERS: 2
};

function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    players: [],
    state: 'lobby',
    category: null,       // filename (e.g. 'football.json')
    categoryKey: null,    // 'football'
    questions: [],
    questionIndex: -1,
    currentQuestion: null,
    questionStartTime: 0,
    questionTimer: null,
    revealTimer: null
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
    category: room.categoryKey,
    categoryMeta: meta,
    players: room.players.map(p => ({
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      answered: p.answered
    })),
    questionIndex: room.questionIndex,
    totalQuestions: CONSTANTS.QUESTIONS_PER_GAME
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', getPublicRoom(room));
}

// ═══════════════════════════════════════════════════
// 7. Socket.io events
// ═══════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`🔌 متصل: ${socket.id}`);

  socket.on('create_room', ({ name, avatar }) => {
    if (!name || !name.trim()) return socket.emit('error_msg', { msg: 'اكتب اسمك أولاً!' });
    const room = createRoom(socket.id);
    room.players.push({
      socketId: socket.id, name: name.trim().slice(0, 15),
      avatar: avatar || '🎮', score: 0, answered: false, answer: null, answerTime: 0, connected: true
    });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('room_created', { code: room.code });
    broadcastRoom(room);
  });

  socket.on('join_room', ({ code, name, avatar }) => {
    if (!name || !code) return socket.emit('error_msg', { msg: 'اكتب اسمك والكود!' });
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', { msg: 'الغرفة غير موجودة!' });
    if (room.state !== 'lobby') return socket.emit('error_msg', { msg: 'اللعبة بدأت بالفعل!' });
    if (room.players.length >= CONSTANTS.MAX_PLAYERS)
      return socket.emit('error_msg', { msg: `الغرفة ممتلئة (${CONSTANTS.MAX_PLAYERS} لاعبين بحد أقصى)!` });

    const cleanName = name.trim().slice(0, 15);
    if (room.players.some(p => p.name === cleanName))
      return socket.emit('error_msg', { msg: 'هذا الاسم مستخدم بالفعل!' });

    room.players.push({
      socketId: socket.id, name: cleanName,
      avatar: avatar || '🎮', score: 0, answered: false, answer: null, answerTime: 0, connected: true
    });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('room_joined', { code: room.code });
    broadcastRoom(room);
  });

  // ═══════════════════════════════════════════════════
  // اختيار القسم — مع تطبيع كامل ورسائل debug واضحة
  // ═══════════════════════════════════════════════════
  socket.on('select_category', ({ category }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) {
      console.error(`❌ select_category: لا توجد غرفة مرتبطة بـ socket ${socket.id}`);
      return;
    }
    if (room.hostId !== socket.id) {
      return socket.emit('error_msg', { msg: 'فقط المضيف يمكنه اختيار القسم!' });
    }

    // 1) تطبيع القيمة الواردة
    const normalized = normalizeCategory(category);

    console.log('\n🎯 [select_category]');
    console.log(`   ├─ القيمة الخام (raw):        "${category}"`);
    console.log(`   ├─ القيمة بعد التطبيع:      "${normalized}"`);

    // 2) البحث في الخريطة
    let filename = CATEGORY_MAP[normalized];

    // 3) محاولة fallback: إذا كانت القيمة اسماً مباشراً للملف (مثل "football.json")
    if (!filename && normalized.endsWith('.json') && UNIQUE_FILES.includes(normalized)) {
      filename = normalized;
      console.log(`   ├─ fallback: تم استخدام اسم الملف مباشرة`);
    }

    // 4) محاولة أخرى: أضف .json للقيم الإنجليز
    if (!filename && /^[a-z]+$/.test(normalized)) {
      const guess = `${normalized}.json`;
      if (UNIQUE_FILES.includes(guess)) {
        filename = guess;
        console.log(`   ├─ fallback: تخمين ${guess}`);
      }
    }

    console.log(`   └─ الملف المُختار: ${filename || '(غير موجود)'}`);

    // 5) التحقق من وجود الملف في الخريطة
    if (!filename) {
      console.error(`   ❌ قسم غير معروف: "${category}"`);
      console.error(`   💡 القيم المتاحة: ${Object.keys(CATEGORY_MAP).join(', ')}`);
      return socket.emit('error_msg', {
        msg: `قسم غير معروف: "${category}". القيم المتاحة: football, general, anime, islamic`
      });
    }

    // 6) التحقق من تحميل الأسئلة
    const bank = QUESTION_BANK[filename];
    if (!Array.isArray(bank) || bank.length === 0) {
      console.error(`   ❌ لا توجد أسئلة محمّلة من: ${filename}`);
      console.error(`   💡 راجع السجل أعلاه لسبب فشل التحميل`);
      const meta = CATEGORY_DISPLAY[filename];
      return socket.emit('error_msg', {
        msg: `لا توجد أسئلة في "${meta ? meta.nameAr : filename}". راجع السجل في الطرفية.`
      });
    }

    // 7) حفظ القسم بنجاح
    room.category = filename;
    room.categoryKey = CATEGORY_DISPLAY[filename].key;
    room.state = 'category';

    console.log(`   ✅ [${room.code}] تم اختيار القسم بنجاح`);
    console.log(`      Category Key: ${room.categoryKey}`);
    console.log(`      File: ${filename}`);
    console.log(`      Questions available: ${bank.length}\n`);

    broadcastRoom(room);
  });

  socket.on('start_game', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف يبدأ اللعبة!' });
    if (room.players.length < CONSTANTS.MIN_PLAYERS)
      return socket.emit('error_msg', { msg: `محتاج ${CONSTANTS.MIN_PLAYERS} لاعبين على الأقل!` });
    if (!room.category) return socket.emit('error_msg', { msg: 'اختر القسم أولاً!' });

    const pool = QUESTION_BANK[room.category];
    if (!pool || pool.length === 0) {
      return socket.emit('error_msg', { msg: 'لا توجد أسئلة في هذا القسم!' });
    }

    const picked = shuffleArray(pool).slice(0, CONSTANTS.QUESTIONS_PER_GAME);
    room.questions = picked.map(shuffleQuestionChoices);
    room.questionIndex = -1;
    room.players.forEach(p => { p.score = 0; p.answered = false; p.answer = null; p.answerTime = 0; });

    console.log(`🎬 [${room.code}] بدء اللعبة — ${room.questions.length} سؤال`);

    io.to(room.code).emit('game_started', {
      category: room.categoryKey,
      categoryMeta: CATEGORY_DISPLAY[room.category],
      totalQuestions: CONSTANTS.QUESTIONS_PER_GAME,
      questionTime: CONSTANTS.QUESTION_TIME
    });
    broadcastRoom(room);
    setTimeout(() => sendNextQuestion(room), 800);
  });

  socket.on('submit_answer', ({ choiceIndex }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || !room.currentQuestion) return;
    if (typeof choiceIndex !== 'number' || choiceIndex < 0 || choiceIndex > 3) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.answered) return;

    const elapsed = (now() - room.questionStartTime) / 1000;
    if (elapsed >= CONSTANTS.QUESTION_TIME) return;

    player.answered = true;
    player.answer = choiceIndex;
    player.answerTime = elapsed;

    if (choiceIndex === room.currentQuestion.correct_index) {
      const speedRatio = 1 - Math.min(elapsed / CONSTANTS.QUESTION_TIME, 1);
      const speedBonus = Math.round(speedRatio * CONSTANTS.MAX_SPEED_BONUS);
      player.score += CONSTANTS.BASE_SCORE + speedBonus;
    }

    io.to(room.code).emit('player_answered', { socketId: player.socketId, name: player.name });
    broadcastRoom(room);

    if (room.players.every(p => p.answered)) {
      clearTimeout(room.questionTimer);
      endQuestion(room);
    }
  });

  socket.on('play_again', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف يمكنه إعادة اللعب!' });
    clearTimeout(room.questionTimer);
    clearTimeout(room.revealTimer);
    room.state = 'lobby';
    room.category = null;
    room.categoryKey = null;
    room.questions = [];
    room.questionIndex = -1;
    room.currentQuestion = null;
    room.players.forEach(p => { p.score = 0; p.answered = false; p.answer = null; p.answerTime = 0; });
    io.to(room.code).emit('room_reset');
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms[code];
    if (!room) return;
    const leaving = room.players.find(p => p.socketId === socket.id);
    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length === 0) {
      clearTimeout(room.questionTimer);
      clearTimeout(room.revealTimer);
      delete rooms[code];
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].socketId;
      io.to(room.code).emit('host_changed', { name: room.players[0].name });
    }
    io.to(room.code).emit('player_left', { name: leaving ? leaving.name : 'لاعب' });

    if (room.state === 'playing' || room.state === 'reveal') {
      if (room.players.length < CONSTANTS.MIN_PLAYERS) {
        clearTimeout(room.questionTimer);
        clearTimeout(room.revealTimer);
        room.state = 'finished';
        endGame(room, 'لا يكفي اللاعبون لإكمال اللعبة');
        return;
      }
      if (room.state === 'playing' && room.players.every(p => p.answered)) {
        clearTimeout(room.questionTimer);
        endQuestion(room);
      }
    }
    broadcastRoom(room);
  });
});

// ═══════════════════════════════════════════════════
// 8. منطق الأسئلة
// ═══════════════════════════════════════════════════
function sendNextQuestion(room) {
  if (room.state === 'finished') return;
  room.questionIndex++;
  if (room.questionIndex >= room.questions.length) return endGame(room, null);

  room.currentQuestion = room.questions[room.questionIndex];
  room.state = 'playing';
  room.questionStartTime = now();
  room.players.forEach(p => { p.answered = false; p.answer = null; p.answerTime = 0; });

  io.to(room.code).emit('new_question', {
    index: room.questionIndex,
    total: room.questions.length,
    question: room.currentQuestion.question,
    choices: room.currentQuestion.choices,
    timeLimit: CONSTANTS.QUESTION_TIME,
    serverStart: room.questionStartTime
  });
  broadcastRoom(room);

  room.questionTimer = setTimeout(() => endQuestion(room), CONSTANTS.QUESTION_TIME * 1000);
}

function endQuestion(room) {
  if (room.state !== 'playing') return;
  room.state = 'reveal';
  const correctIndex = room.currentQuestion.correct_index;

  io.to(room.code).emit('question_result', {
    correctIndex,
    correctAnswer: room.currentQuestion.choices[correctIndex],
    scores: room.players.map(p => ({
      name: p.name, avatar: p.avatar, score: p.score,
      answered: p.answered, wasCorrect: p.answer === correctIndex, answerTime: p.answerTime
    }))
  });
  broadcastRoom(room);

  room.revealTimer = setTimeout(() => {
    if (room.state !== 'reveal') return;
    sendNextQuestion(room);
  }, CONSTANTS.REVEAL_TIME * 1000);
}

function endGame(room, reason) {
  room.state = 'finished';
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  io.to(room.code).emit('game_over', {
    reason: reason || null,
    rankings: sorted.map((p, i) => ({ rank: i + 1, name: p.name, avatar: p.avatar, score: p.score }))
  });
  broadcastRoom(room);
}

// ═══════════════════════════════════════════════════
// 9. تشغيل السيرفر
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎯 ع السريع يعمل على المنفذ ${PORT}`);
  console.log(`🌐 افتح: http://localhost:${PORT}\n`);
});