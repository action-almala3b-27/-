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

// ============================================
// 1. تعريف الأقسام وملفاتها
//    ⚠️ الأسماء هنا يجب أن تُطابق تماماً:
//    - القيم المُرسلة من الواجهة (data-cat)
//    - أسماء الملفات في الجذر
// ============================================
const CATEGORIES = {
  football:  { file: 'football.json',  nameAr: 'كرة القدم',      icon: '⚽' },
  general:   { file: 'general.json',   nameAr: 'معلومات عامة',   icon: '🧠' },
  anime:     { file: 'anime.json',     nameAr: 'أنمي',           icon: '🎌' },
  islamic:   { file: 'islamic.json',   nameAr: 'إسلاميات',       icon: '🕌' }
};

const QUESTION_BANK = {};

// ============================================
// 2. تحميل ملفات الأسئلة مع تسجيل مفصّل
// ============================================
function loadQuestions() {
  console.log('\n═══════════════════════════════════════════');
  console.log('📚 بدء تحميل بنك الأسئلة');
  console.log('📂 مجلد المشروع:', __dirname);
  console.log('═══════════════════════════════════════════');

  Object.entries(CATEGORIES).forEach(([key, meta]) => {
    const fullPath = path.resolve(__dirname, meta.file);

    console.log(`\n🔍 [${key}] جاري قراءة: ${meta.file}`);
    console.log(`   └─ المسار الكامل: ${fullPath}`);

    // 1) فحص وجود الملف
    if (!fs.existsSync(fullPath)) {
      console.error(`   ❌ الملف غير موجود: ${fullPath}`);
      console.error(`   💡 تأكد أن اسم الملف هو "${meta.file}" بالضبط (حساس لحالة الأحرف)`);
      QUESTION_BANK[key] = [];
      return;
    }

    // 2) قراءة الملف
    let raw;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      console.error(`   ❌ فشل قراءة الملف: ${err.message}`);
      QUESTION_BANK[key] = [];
      return;
    }

    // 3) إزالة BOM إن وُجد
    if (raw.charCodeAt(0) === 0xFEFF) {
      raw = raw.slice(1);
      console.warn(`   ⚠️ تم إزالة BOM من بداية الملف`);
    }

    // 4) تحليل JSON
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`   ❌ خطأ في صياغة JSON: ${err.message}`);
      console.error(`   💡 تحقق من علامات التنصيص والفواصل في "${meta.file}"`);
      // طباعة سياق الخطأ
      if (err.message.includes('position')) {
        const match = err.message.match(/position (\d+)/);
        if (match) {
          const pos = parseInt(match[1]);
          const snippet = raw.substring(Math.max(0, pos - 40), pos + 40);
          console.error(`   📍 السياق: ...${snippet}...`);
        }
      }
      QUESTION_BANK[key] = [];
      return;
    }

    // 5) التحقق من أن الجذر مصفوفة
    if (!Array.isArray(parsed)) {
      console.error(`   ❌ الملف ليس مصفوفة. النوع المكتشف: ${typeof parsed}`);
      console.error(`   💡 يجب أن يبدأ الملف بـ [ وينتهي بـ ]`);
      QUESTION_BANK[key] = [];
      return;
    }

    console.log(`   ✅ نجح تحليل JSON — عدد العناصر الخام: ${parsed.length}`);

    // 6) فلترة الأسئلة الصحيحة
    const valid = [];
    const rejected = [];
    let legacyFormatCount = 0;

    parsed.forEach((q, idx) => {
      if (!q || typeof q !== 'object') {
        rejected.push({ idx, reason: 'ليس كائناً' });
        return;
      }

      // كشف الصيغة القديمة (id/name) التي كانت تُستخدم في مشروع التمثيل
      if (('id' in q || 'name' in q) && !('question' in q)) {
        legacyFormatCount++;
        return;
      }

      // القبول بصيغة question/choices/correct_index أو q/c/a
      const questionText = q.question ?? q.q;
      const choicesArr   = q.choices  ?? q.c;
      const correctIdx   = q.correct_index ?? q.a;

      if (typeof questionText !== 'string' || questionText.trim() === '') {
        rejected.push({ idx, reason: 'حقل question/q مفقود أو ليس نصاً' });
        return;
      }
      if (!Array.isArray(choicesArr) || choicesArr.length !== 4) {
        rejected.push({ idx, reason: `choices/c يجب أن تكون مصفوفة بـ 4 عناصر (الموجود: ${Array.isArray(choicesArr) ? choicesArr.length : 'غير مصفوفة'})` });
        return;
      }
      if (typeof correctIdx !== 'number' || correctIdx < 0 || correctIdx > 3) {
        rejected.push({ idx, reason: `correct_index/a يجب أن يكون رقماً بين 0 و 3` });
        return;
      }

      // توحيد الصيغة
      valid.push({
        question: questionText.trim(),
        choices: choicesArr.map(c => String(c)),
        correct_index: correctIdx
      });
    });

    QUESTION_BANK[key] = valid;

    // 7) تقرير نهائي مفصل
    console.log(`   ✅ أسئلة صالحة: ${valid.length}`);

    if (legacyFormatCount > 0) {
      console.error(`   🚨 تحذير كبير: ${legacyFormatCount} عنصر بصيغة قديمة ({ id, name })`);
      console.error(`   💡 هذا الملف يبدو أنه من مشروع "التمثيل" وليس "ع السريع"`);
      console.error(`   💡 الصيغة المطلوبة: { "question": "...", "choices": [4 items], "correct_index": 0-3 }`);
    }

    if (rejected.length > 0) {
      console.warn(`   ⚠️ عناصر مرفوضة: ${rejected.length}`);
      // طباعة أول 3 عناصر مرفوضة فقط
      rejected.slice(0, 3).forEach(r => {
        console.warn(`      - العنصر #${r.idx}: ${r.reason}`);
      });
      if (rejected.length > 3) {
        console.warn(`      ... و ${rejected.length - 3} عنصر آخر`);
      }
    }

    if (valid.length === 0) {
      console.error(`   ❌❌ لا يوجد أي سؤال صالح في "${meta.file}"!`);
      console.error(`   💡 افتح الملف وتأكد أنه يحتوي على أسئلة بصيغة صحيحة.`);
      console.error(`   💡 مثال للصيغة الصحيحة:`);
      console.error(`      [{ "question": "ما هي عاصمة مصر؟", "choices": ["القاهرة", "الجيزة", "أسوان", "طنطا"], "correct_index": 0 }]`);
    }
  });

  console.log('\n═══════════════════════════════════════════');
  console.log('📊 ملخص التحميل:');
  Object.entries(QUESTION_BANK).forEach(([k, v]) => {
    const status = v.length > 0 ? '✅' : '❌';
    console.log(`   ${status} ${CATEGORIES[k].nameAr} (${k}): ${v.length} سؤال`);
  });
  console.log('═══════════════════════════════════════════\n');
}

loadQuestions();

// ============================================
// 3. أدوات مساعدة
// ============================================
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

// ============================================
// 4. إدارة الغرف
// ============================================
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
    category: null,
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
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    category: room.category,
    categoryMeta: room.category ? CATEGORIES[room.category] : null,
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

// ============================================
// 5. Socket.io events
// ============================================
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

  // ============================================
  // اختيار القسم — مع تحقق صارم ورسالة خطأ واضحة
  // ============================================
  socket.on('select_category', ({ category }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (room.hostId !== socket.id)
      return socket.emit('error_msg', { msg: 'فقط المضيف يمكنه اختيار القسم!' });

    // ⚠️ التحقق الحاسم: هل القسم موجود في CATEGORIES؟
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) {
      console.error(`❌ قسم غير معروف: "${category}"`);
      console.error(`   الأقسام المتاحة: ${Object.keys(CATEGORIES).join(', ')}`);
      return socket.emit('error_msg', { msg: `قسم غير معروف: ${category}` });
    }

    // ⚠️ التحقق الحاسم: هل تم تحميل أسئلة هذا القسم؟
    const bank = QUESTION_BANK[category];
    if (!Array.isArray(bank) || bank.length === 0) {
      console.error(`❌ لا توجد أسئلة محمّلة للقسم: ${category}`);
      console.error(`   💡 تحقق من السجل أعلاه للتفاصيل`);
      return socket.emit('error_msg', {
        msg: `لا توجد أسئلة متاحة في قسم "${CATEGORIES[category].nameAr}". تأكد من أن ملف ${CATEGORIES[category].file} يحتوي على أسئلة بصيغة صحيحة.`
      });
    }

    room.category = category;
    room.state = 'category';
    console.log(`✅ [${room.code}] تم اختيار القسم: ${category} (${bank.length} سؤال متاح)`);
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

    io.to(room.code).emit('game_started', {
      category: room.category,
      categoryMeta: CATEGORIES[room.category],
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

// ============================================
// 6. منطق الأسئلة
// ============================================
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

// ============================================
// 7. تشغيل السيرفر
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎯 ع السريع يعمل على المنفذ ${PORT}`);
  console.log(`🌐 افتح: http://localhost:${PORT}\n`);
});