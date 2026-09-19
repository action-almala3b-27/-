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
// 1. تحميل بنك الأسئلة من الملفات الأربعة
// ============================================
const CATEGORIES = {
  football:  { file: 'football.json',  nameAr: 'كرة القدم',      icon: '⚽' },
  general:   { file: 'general.json',   nameAr: 'معلومات عامة',   icon: '🧠' },
  anime:     { file: 'anime.json',     nameAr: 'أنمي',           icon: '🎌' },
  islamic:   { file: 'islamic.json',   nameAr: 'إسلاميات',       icon: '🕌' }
};

const QUESTION_BANK = {};

function loadQuestions() {
  Object.entries(CATEGORIES).forEach(([key, meta]) => {
    try {
      const fullPath = path.join(__dirname, meta.file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(raw);
      QUESTION_BANK[key] = parsed.filter(q =>
        q && typeof q.question === 'string' &&
        Array.isArray(q.choices) && q.choices.length === 4 &&
        typeof q.correct_index === 'number'
      );
      console.log(`✅ تم تحميل ${QUESTION_BANK[key].length} سؤال من ${meta.file}`);
    } catch (err) {
      console.error(`❌ فشل تحميل ${meta.file}:`, err.message);
      QUESTION_BANK[key] = [];
    }
  });
}

loadQuestions();

// ============================================
// 2. أدوات مساعدة
// ============================================
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// خلط خيارات السؤال وإرجاع نسخة جديدة مع correct_index الجديد
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

function now() {
  return Date.now();
}

// ============================================
// 3. إدارة الغرف
// ============================================
const rooms = {};

const CONSTANTS = {
  QUESTIONS_PER_GAME: 10,
  QUESTION_TIME: 15,          // ثانية
  REVEAL_TIME: 4,             // ثانية عرض الإجابة الصحيحة
  BASE_SCORE: 500,            // نقاط أساسية للإجابة الصحيحة
  MAX_SPEED_BONUS: 500,       // نقاط إضافية بحد أقصى حسب السرعة
  MAX_PLAYERS: 4,
  MIN_PLAYERS: 2
};

function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    players: [],              // { socketId, name, avatar, score, answered, answer, answerTime, connected }
    state: 'lobby',           // lobby | category | playing | reveal | finished
    category: null,
    questions: [],            // أسئلة مخلوطة
    questionIndex: -1,
    currentQuestion: null,    // { question, choices, correct_index }
    questionStartTime: 0,
    questionTimer: null,
    revealTimer: null,
    revealEndsAt: 0
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
// 4. Socket.io events
// ============================================
io.on('connection', (socket) => {
  console.log(`🔌 متصل: ${socket.id}`);

  // -------- إنشاء غرفة --------
  socket.on('create_room', ({ name, avatar }) => {
    if (!name || !name.trim()) return socket.emit('error_msg', { msg: 'اكتب اسمك أولاً!' });

    const room = createRoom(socket.id);
    room.players.push({
      socketId: socket.id,
      name: name.trim().slice(0, 15),
      avatar: avatar || '🎮',
      score: 0,
      answered: false,
      answer: null,
      answerTime: 0,
      connected: true
    });

    socket.join(room.code);
    socket.data.roomCode = room.code;

    socket.emit('room_created', { code: room.code });
    broadcastRoom(room);
  });

  // -------- الانضمام لغرفة --------
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
      socketId: socket.id,
      name: cleanName,
      avatar: avatar || '🎮',
      score: 0,
      answered: false,
      answer: null,
      answerTime: 0,
      connected: true
    });

    socket.join(room.code);
    socket.data.roomCode = room.code;

    socket.emit('room_joined', { code: room.code });
    broadcastRoom(room);
  });

  // -------- اختيار القسم من المضيف --------
  socket.on('select_category', ({ category }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف يمكنه اختيار القسم!' });
    if (!CATEGORIES[category]) return socket.emit('error_msg', { msg: 'قسم غير صالح!' });
    if (!QUESTION_BANK[category] || QUESTION_BANK[category].length === 0)
      return socket.emit('error_msg', { msg: 'لا توجد أسئلة في هذا القسم!' });

    room.category = category;
    room.state = 'category';
    broadcastRoom(room);
  });

  // -------- بدء اللعبة من المضيف --------
  socket.on('start_game', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف يبدأ اللعبة!' });
    if (room.players.length < CONSTANTS.MIN_PLAYERS)
      return socket.emit('error_msg', { msg: `محتاج ${CONSTANTS.MIN_PLAYERS} لاعبين على الأقل!` });
    if (!room.category) return socket.emit('error_msg', { msg: 'اختر القسم أولاً!' });

    // تحضير الأسئلة
    const pool = QUESTION_BANK[room.category];
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

  // -------- استقبال الإجابة --------
  socket.on('submit_answer', ({ choiceIndex }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing') return;
    if (!room.currentQuestion) return;
    if (typeof choiceIndex !== 'number' || choiceIndex < 0 || choiceIndex > 3) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.answered) return;

    const elapsed = (now() - room.questionStartTime) / 1000;   // بالثواني
    if (elapsed >= CONSTANTS.QUESTION_TIME) return;

    player.answered = true;
    player.answer = choiceIndex;
    player.answerTime = elapsed;

    // هل الإجابة صحيحة؟
    if (choiceIndex === room.currentQuestion.correct_index) {
      // نقاط أساسية + مكافأة سرعة
      const speedRatio = 1 - Math.min(elapsed / CONSTANTS.QUESTION_TIME, 1);
      const speedBonus = Math.round(speedRatio * CONSTANTS.MAX_SPEED_BONUS);
      player.score += CONSTANTS.BASE_SCORE + speedBonus;
    }

    // إبلاغ الجميع أن هذا اللاعب أجاب
    io.to(room.code).emit('player_answered', {
      socketId: player.socketId,
      name: player.name
    });
    broadcastRoom(room);

    // هل الجميع أجاب؟
    const allAnswered = room.players.every(p => p.answered);
    if (allAnswered) {
      clearTimeout(room.questionTimer);
      endQuestion(room);
    }
  });

  // -------- إعادة اللعب --------
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

  // -------- خروج اللاعب --------
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
      console.log(`🗑️ حذف الغرفة ${code}`);
      return;
    }

    // نقل الملكية للمضيف الجديد
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].socketId;
      io.to(room.code).emit('host_changed', { name: room.players[0].name });
    }

    io.to(room.code).emit('player_left', { name: leaving ? leaving.name : 'لاعب' });

    // إذا كانت اللعبة جارية
    if (room.state === 'playing' || room.state === 'reveal') {
      if (room.players.length < CONSTANTS.MIN_PLAYERS) {
        clearTimeout(room.questionTimer);
        clearTimeout(room.revealTimer);
        room.state = 'finished';
        endGame(room, 'لا يكفي اللاعبون لإكمال اللعبة');
        return;
      }
      // إذا كان الذي غادر هو آخر من لم يجب، ننتقل للسؤال التالي
      if (room.state === 'playing') {
        const allAnswered = room.players.every(p => p.answered);
        if (allAnswered) {
          clearTimeout(room.questionTimer);
          endQuestion(room);
        }
      }
    }

    broadcastRoom(room);
  });
});

// ============================================
// 5. منطق الأسئلة
// ============================================
function sendNextQuestion(room) {
  if (room.state === 'finished') return;

  room.questionIndex++;

  if (room.questionIndex >= room.questions.length) {
    return endGame(room, null);
  }

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

  room.questionTimer = setTimeout(() => {
    endQuestion(room);
  }, CONSTANTS.QUESTION_TIME * 1000);
}

function endQuestion(room) {
  if (room.state !== 'playing') return;
  room.state = 'reveal';

  const correctIndex = room.currentQuestion.correct_index;

  // إرسال النتائج للجميع
  io.to(room.code).emit('question_result', {
    correctIndex,
    correctAnswer: room.currentQuestion.choices[correctIndex],
    scores: room.players.map(p => ({
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      answered: p.answered,
      wasCorrect: p.answer === correctIndex,
      answerTime: p.answerTime
    }))
  });

  broadcastRoom(room);

  // مؤقت الانتقال للسؤال التالي
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
    rankings: sorted.map((p, i) => ({
      rank: i + 1,
      name: p.name,
      avatar: p.avatar,
      score: p.score
    }))
  });

  broadcastRoom(room);
}

// ============================================
// 6. تشغيل السيرفر
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎯 ع السريع يعمل على المنفذ ${PORT}`);
});