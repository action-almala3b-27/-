// ═══════════════════════════════════════════════════════════
// ع السريع — سيرفر مع تحميل مسبق + Groq API (مجاني)
// ═══════════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const cors = require('cors');
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

// ═══════════════════════════════════════════════════════════
// 🔑 Groq API — 14,400 طلب مجاني يومياً
// ═══════════════════════════════════════════════════════════
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// المفتاح لازم يتحط في Environment Variable اسمه GROQ_KEY على Railway
// (متسربش المفتاح في الكود أبداً — لو ظهر مرة يبقى لازم تلغيه فوراً وتطلع واحد جديد)
const GROQ_KEY = process.env.GROQ_KEY || '';

if (!GROQ_KEY) {
  console.warn('⚠️ تحذير: GROQ_KEY مش معرّف في Environment Variables!');
}

// ⚡ نماذج Groq — الموديلات دي هي المتاحة فعلياً لهذا الحساب (تم التأكد بالاختبار المباشر)
// لو حسابك عنده وصول لموديلات تانية (llama, mixtral..) ضيفها هنا بعد ما تتأكد منها
// عبر GET https://api.groq.com/openai/v1/models
const GROQ_MODELS = [
  'openai/gpt-oss-120b',   // الأقوى المتاح لهذا الحساب
  'openai/gpt-oss-20b'     // احتياطي أسرع
];

const QUESTIONS_TARGET = 40;
const QUESTIONS_MIN_ACCEPT = 25;
const API_TIMEOUT_MS = 45000;

const CATEGORY_DESCRIPTIONS = {
  football: 'كرة القدم: كأس العالم، دوري أبطال أوروبا، اللاعبون التاريخيون، الأندية الكبرى، المدربون، الانتقالات الشهيرة، الأرقام القياسية، الشعارات، التشكيلات، البطولات المحلية والقارية.',
  general:  'معلومات عامة: العلوم، الفيزياء، الكيمياء، الأحياء، الفلك، الفضاء، التاريخ، الجغرافيا، العواصم، الأنهار، الجبال، التقنية، الاختراعات، الرياضيات، الحيوانات.',
  anime:    'الأنمي والمانغا اليابانية: الشخصيات الشهيرة، الأعمال الكلاسيكية والحديثة، المؤلفون، الأحداث الرئيسية، الاستوديوهات المنتجة، المانغا الأصلية، الأفلام.',
  islamic:  'الإسلاميات: القرآن الكريم، التفسير، السيرة النبوية، الصحابة الكرام، الفقه، الأنبياء والرسل، الغزوات، الحديث الشريف، الأئمة، الفتوحات، الحضارة الإسلامية.'
};

// ═══════════════════════════════════════════════════════════
// 🌐 الكاش العالمي
// ═══════════════════════════════════════════════════════════
const QUESTIONS_CACHE = {};
const CACHE_TIMESTAMPS = {};
const PREFETCH_PROMISES = {};
const CACHE_AGE_MS = 4 * 60 * 60 * 1000;

const ALL_CATEGORY_KEYS = ['football', 'general', 'anime', 'islamic'];

// ═══════════════════════════════════════════════════════════
// خريطة الأقسام
// ═══════════════════════════════════════════════════════════
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

const CATEGORY_DISPLAY = {
  'football.json': { key: 'football', nameAr: 'كرة القدم',    icon: '⚽' },
  'general.json':  { key: 'general',  nameAr: 'معلومات عامة', icon: '🧠' },
  'anime.json':    { key: 'anime',    nameAr: 'أنمي',         icon: '🎌' },
  'islamic.json':  { key: 'islamic',  nameAr: 'إسلاميات',     icon: '🕌' }
};

const UNIQUE_FILES = [...new Set(Object.values(CATEGORY_MAP))];

function normalizeCategory(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ═══════════════════════════════════════════════════════════
// بناء الـ prompt (يجب أن يحتوي على كلمة JSON للنمط المنظم)
// ═══════════════════════════════════════════════════════════
function buildQuestionsPrompt(categoryKey, categoryNameAr) {
  const description = CATEGORY_DESCRIPTIONS[categoryKey] || '';

  return `أعد ${QUESTIONS_TARGET} سؤال اختيار من متعدد باللغة العربية في موضوع "${categoryNameAr}".

الوصف التفصيلي: ${description}

قواعد الصعوبة (موزّعة عشوائياً):
• 40% سهلة (يعرفها أي شخص)
• 30% متوسطة (تحتاج متابعة)
• 20% صعبة (للمتابعين الشغوفين)
• 10% شبه مستحيلة (تفاصيل نادرة جداً)

شروط إلزامية:
1. كل سؤال له 4 خيارات، واحد صحيح.
2. لا تكرر أي سؤال.
3. معلومات دقيقة وحديثة.
4. النصوص بالعربية الفصحى فقط.
5. التزم حرفياً بموضوع "${categoryNameAr}".
6. الخيارات قصيرة (1-5 كلمات).

يجب أن تكون الإجابة بصيغة JSON فقط بهذه البنية:
{"questions":[{"question":"نص السؤال؟","choices":["خيار1","خيار2","خيار3","خيار4"],"correct_index":0}]}`;
}

// ═══════════════════════════════════════════════════════════
// محاولة واحدة بنموذج معين
// ═══════════════════════════════════════════════════════════
async function trySingleRequest(model, apiKey, prompt, signal) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: 'أنت مساعد يلتزم بالتعليمات ويُرجع JSON صالحاً فقط.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 1.0,
      max_tokens: 8000
    }),
    signal
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.detail = errText.slice(0, 200);
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('رد فارغ');

  let cleanText = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const first = cleanText.indexOf('{');
  const last = cleanText.lastIndexOf('}');
  if (first !== -1 && last > first) cleanText = cleanText.slice(first, last + 1);

  const parsed = JSON.parse(cleanText);
  const rawQuestions = parsed.questions || parsed.Questions || [];

  const valid = [];
  const seen = new Set();

  rawQuestions.forEach(q => {
    if (!q || typeof q.question !== 'string') return;
    const qText = q.question.trim();
    if (seen.has(qText)) return;

    const choices = q.choices || q.options;
    const idx = Number(q.correct_index ?? q.correctIndex ?? q.answer);

    if (!Array.isArray(choices) || choices.length !== 4) return;
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;
    if (qText.length < 5) return;

    seen.add(qText);
    valid.push({ question: qText, choices: choices.map(String), correct_index: idx });
  });

  if (valid.length < 5) throw new Error(`عدد قليل (${valid.length})`);
  return valid;
}

// ═══════════════════════════════════════════════════════════
// توليد من الـ API — مع تخطي ذكي للأخطاء
// ═══════════════════════════════════════════════════════════
async function generateQuestionsFromAPI(categoryKey) {
  const meta = Object.values(CATEGORY_DISPLAY).find(m => m.key === categoryKey);
  if (!meta) throw new Error('قسم غير معروف');

  const prompt = buildQuestionsPrompt(categoryKey, meta.nameAr);
  let lastError = null;

  for (const model of GROQ_MODELS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const startTime = Date.now();
      console.log(`🤖 [${model}] قسم "${meta.nameAr}"...`);

      const questions = await trySingleRequest(model, GROQ_KEY, prompt, controller.signal);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`✅ [${model}] ${questions.length} سؤال في ${elapsed}s`);
      clearTimeout(timer);
      return questions;

    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const status = err && err.status;

      // تخطي فوري — بدون طباعة تحذير
      if (status === 404) continue;
      if (status === 429) continue;
      if (status === 401 || status === 403) continue;
      if (status === 400) continue;

      console.warn(`⚠️ [${model}]: ${err.message}`);
    }
  }

  throw lastError || new Error('كل النماذج فشلت');
}

// ═══════════════════════════════════════════════════════════
// 🚀 التحميل المسبق
// ═══════════════════════════════════════════════════════════
function startPrefetch(categoryKey) {
  const now = Date.now();
  const cached = QUESTIONS_CACHE[categoryKey];
  const age = now - (CACHE_TIMESTAMPS[categoryKey] || 0);
  if (cached && cached.length >= QUESTIONS_MIN_ACCEPT && age < CACHE_AGE_MS) {
    return Promise.resolve(cached);
  }

  if (PREFETCH_PROMISES[categoryKey]) {
    return PREFETCH_PROMISES[categoryKey];
  }

  const promise = generateQuestionsFromAPI(categoryKey)
    .then(qs => {
      QUESTIONS_CACHE[categoryKey] = qs;
      CACHE_TIMESTAMPS[categoryKey] = Date.now();
      delete PREFETCH_PROMISES[categoryKey];
      return qs;
    })
    .catch(err => {
      console.error(`❌ [Prefetch] ${categoryKey}: ${err.message}`);
      delete PREFETCH_PROMISES[categoryKey];
      throw err;
    });

  PREFETCH_PROMISES[categoryKey] = promise;
  return promise;
}

function prefetchAllCategories() {
  console.log('\n🚀 [Prefetch] بدء تحميل الأقسام الأربعة بالتوازي...');
  ALL_CATEGORY_KEYS.forEach(key => {
    startPrefetch(key).catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════
// جلب الأسئلة عند الحاجة
// ═══════════════════════════════════════════════════════════
async function getQuestionsForCategory(categoryKey) {
  const now = Date.now();
  const cached = QUESTIONS_CACHE[categoryKey];
  const age = now - (CACHE_TIMESTAMPS[categoryKey] || 0);

  if (cached && cached.length >= QUESTIONS_MIN_ACCEPT && age < CACHE_AGE_MS) {
    const minAgo = Math.floor(age / 60000);
    console.log(`⚡ [CACHE] ${categoryKey} → ${cached.length} سؤال (${minAgo} دقيقة)`);
    return cached;
  }

  if (PREFETCH_PROMISES[categoryKey]) {
    console.log(`⏳ انتظار "${categoryKey}"...`);
    try {
      return await PREFETCH_PROMISES[categoryKey];
    } catch (e) {
      console.error(`❌ فشل: ${e.message}`);
    }
  }

  console.log(`🆕 طلب جديد: "${categoryKey}"...`);
  try {
    return await startPrefetch(categoryKey);
  } catch (e) {
    if (cached && cached.length > 0) {
      console.log(`⚡ [CACHE قديم] ${cached.length} سؤال`);
      return cached;
    }
    throw new Error('تعذّر توليد الأسئلة');
  }
}

// ═══════════════════════════════════════════════════════════
// أدوات
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// الغرف
// ═══════════════════════════════════════════════════════════
const rooms = {};

function generateRoomCode() {
  let code;
  let attempts = 0;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
    if (attempts > 500) break;
  } while (rooms[code]);
  return code;
}

function normalizeRoomCode(raw) {
  if (raw == null) return '';
  return String(raw).trim().replace(/\s+/g, '');
}

const CONSTANTS = {
  TARGET_SCORE: 10,
  MAX_PLAYERS: 4,
  MIN_PLAYERS: 2,
  NEXT_QUESTION_DELAY: 1500
};

const JOINABLE_STATES = new Set(['lobby', 'category']);

function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code, hostId: hostSocketId, players: [],
    isStarted: false, state: 'lobby',
    category: null, categoryKey: null,
    questionPool: [], questionIndex: -1,
    currentQuestion: null, removedChoices: new Set(),
    lastCorrectIndex: null, roundWinner: null,
    advanceTimer: null, generating: false
  };
  rooms[code] = room;
  return room;
}

function getPublicRoom(room) {
  const meta = room.category ? CATEGORY_DISPLAY[room.category] : null;
  return {
    code: room.code, hostId: room.hostId,
    state: room.state, isStarted: room.isStarted,
    category: room.categoryKey, categoryMeta: meta,
    players: room.players.map(p => ({
      name: p.name, avatar: p.avatar, score: p.score,
      locked: p.lockedThisRound, connected: p.connected
    })),
    targetScore: CONSTANTS.TARGET_SCORE,
    questionNumber: room.questionIndex + 1,
    removedChoices: Array.from(room.removedChoices),
    generating: room.generating
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', getPublicRoom(room));
}

function pickNextQuestion(room) {
  if (room.questionIndex + 1 >= room.questionPool.length) {
    room.questionPool = shuffleArray(room.questionPool).map(shuffleQuestionChoices);
    room.questionIndex = -1;
    console.log(`🔁 [${room.code}] إعادة خلط ${room.questionPool.length} سؤال`);
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
    index: room.questionIndex, question: q.question,
    choices: q.choices, targetScore: CONSTANTS.TARGET_SCORE,
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
    rankings: sorted.map((p, i) => ({ rank: i + 1, name: p.name, avatar: p.avatar, score: p.score }))
  });
  broadcastRoom(room);
  console.log(`🏆 [${room.code}] الفائز: ${winner ? winner.name : 'لا أحد'}`);
}

// ═══════════════════════════════════════════════════════════
// Socket.io
// ═══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`🔌 اتصال: ${socket.id}`);

  socket.on('create_room', ({ name, avatar }) => {
    if (!name || !name.trim()) return socket.emit('error_msg', { msg: 'اكتب اسمك!' });

    prefetchAllCategories();

    const room = createRoom(socket.id);
    room.players.push({
      socketId: socket.id, name: name.trim().slice(0, 15),
      avatar: avatar || '🎮', score: 0,
      lockedThisRound: false, connected: true
    });

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('room_created', { code: room.code });
    broadcastRoom(room);
    console.log(`🏠 [${room.code}] "${name.trim()}" — بدأ التحميل المسبق`);
  });

  socket.on('join_room', ({ code, name, avatar }) => {
    if (!name || !name.trim()) return socket.emit('error_msg', { msg: 'اكتب اسمك!' });

    const roomCode = normalizeRoomCode(code);
    const room = rooms[roomCode];
    if (!room) return socket.emit('error_msg', { msg: 'الغرفة غير موجودة!' });
    if (room.isStarted || !JOINABLE_STATES.has(room.state)) {
      return socket.emit('error_msg', { msg: 'اللعبة بدأت!' });
    }
    if (room.players.length >= CONSTANTS.MAX_PLAYERS) {
      return socket.emit('error_msg', { msg: 'الغرفة ممتلئة!' });
    }

    const cleanName = name.trim().slice(0, 15);
    if (room.players.some(p => p.name === cleanName)) {
      return socket.emit('error_msg', { msg: 'الاسم مستخدم!' });
    }

    room.players.push({
      socketId: socket.id, name: cleanName,
      avatar: avatar || '🎮', score: 0,
      lockedThisRound: false, connected: true
    });

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.emit('room_joined', { code: room.code });
    broadcastRoom(room);
    console.log(`✅ [${room.code}] "${cleanName}" انضم`);
  });

  socket.on('select_category', ({ category }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return socket.emit('error_msg', { msg: 'الغرفة غير موجودة!' });
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف!' });
    if (room.isStarted || !JOINABLE_STATES.has(room.state)) return;

    const normalized = normalizeCategory(category);
    let filename = CATEGORY_MAP[normalized];
    if (!filename && /^[a-z]+$/.test(normalized)) {
      const guess = `${normalized}.json`;
      if (UNIQUE_FILES.includes(guess)) filename = guess;
    }
    if (!filename) return socket.emit('error_msg', { msg: `قسم غير معروف: "${category}"` });

    room.category = filename;
    room.categoryKey = CATEGORY_DISPLAY[filename].key;

    startPrefetch(room.categoryKey).catch(() => {});

    broadcastRoom(room);
    console.log(`🎯 [${room.code}] القسم: ${room.categoryKey}`);
  });

  socket.on('start_game', async () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return socket.emit('error_msg', { msg: 'الغرفة غير موجودة!' });
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف!' });
    if (room.isStarted) return socket.emit('error_msg', { msg: 'بدأت بالفعل!' });
    if (room.players.length < CONSTANTS.MIN_PLAYERS) {
      return socket.emit('error_msg', { msg: 'محتاج لاعبين على الأقل!' });
    }
    if (!room.category) return socket.emit('error_msg', { msg: 'اختر القسم!' });
    if (room.generating) return;

    room.isStarted = true;
    room.generating = true;

    const isReady = QUESTIONS_CACHE[room.categoryKey] &&
                    QUESTIONS_CACHE[room.categoryKey].length >= QUESTIONS_MIN_ACCEPT;

    if (isReady) {
      console.log(`⚡ [${room.code}] الأسئلة جاهزة — بدء فوري`);
    } else {
      console.log(`⏳ [${room.code}] انتظار التحميل...`);
    }

    try {
      const questions = await getQuestionsForCategory(room.categoryKey);

      if (!questions || questions.length < 5) {
        throw new Error('عدد الأسئلة غير كافٍ');
      }

      room.questionPool = shuffleArray(questions).map(shuffleQuestionChoices);
      room.questionIndex = -1;
      room.removedChoices = new Set();
      room.players.forEach(p => { p.score = 0; p.lockedThisRound = false; });

      room.generating = false;
      room.state = 'playing';

      console.log(`✅ [${room.code}] جاهزون — ${room.questionPool.length} سؤال`);

      io.to(room.code).emit('game_started', {
        category: room.categoryKey,
        categoryMeta: CATEGORY_DISPLAY[room.category],
        targetScore: CONSTANTS.TARGET_SCORE
      });
      broadcastRoom(room);

      setTimeout(() => sendNextQuestion(room), 200);

    } catch (err) {
      console.error(`❌ [${room.code}] فشل:`, err.message);

      room.generating = false;
      room.isStarted = false;
      room.state = 'category';

      io.to(room.code).emit('generating_failed', {
        message: 'تعذّر تحضير الأسئلة. حاول مرة أخرى.'
      });
      broadcastRoom(room);
    }
  });

  socket.on('submit_answer', ({ choiceIndex }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || !room.currentQuestion) return;
    if (typeof choiceIndex !== 'number' || choiceIndex < 0 || choiceIndex > 3) return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.lockedThisRound) return;
    if (room.removedChoices.has(choiceIndex)) return;

    const isCorrect = (choiceIndex === room.currentQuestion.correct_index);

    if (isCorrect) {
      player.score += 1;
      player.lockedThisRound = true;
      room.lastCorrectIndex = choiceIndex;
      room.roundWinner = player.name;
      room.state = 'reveal';

      io.to(room.code).emit('answer_correct', {
        winnerName: player.name, winnerSocketId: player.socketId,
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

      io.to(room.code).emit('answer_wrong', {
        playerName: player.name, playerSocketId: player.socketId,
        choiceIndex, removedChoices: Array.from(room.removedChoices),
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

  socket.on('play_again', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.hostId !== socket.id) return;
    clearTimeout(room.advanceTimer);

    room.state = 'lobby';
    room.isStarted = false;
    room.generating = false;
    room.category = null;
    room.categoryKey = null;
    room.questionPool = [];
    room.questionIndex = -1;
    room.currentQuestion = null;
    room.removedChoices = new Set();
    room.players.forEach(p => { p.score = 0; p.lockedThisRound = false; });

    io.to(room.code).emit('room_reset');
    broadcastRoom(room);
    console.log(`🔄 [${room.code}] إعادة اللعب`);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms[code];
    if (!room) return;

    const leaving = room.players.find(p => p.socketId === socket.id);
    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length === 0) {
      clearTimeout(room.advanceTimer);
      delete rooms[code];
      console.log(`🗑️ [${code}] حُذفت الغرفة`);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].socketId;
      io.to(room.code).emit('host_changed', { name: room.players[0].name });
      console.log(`👑 [${code}] المضيف الجديد: ${room.players[0].name}`);
    }

    io.to(room.code).emit('player_left', { name: leaving ? leaving.name : 'لاعب' });

    if (room.state === 'playing') {
      const remaining = room.players.filter(p => !p.lockedThisRound);
      if (remaining.length === 0) {
        room.state = 'reveal';
        clearTimeout(room.advanceTimer);
        room.advanceTimer = setTimeout(() => sendNextQuestion(room), 1500);
      }
    }

    broadcastRoom(room);
  });
});

// ═══════════════════════════════════════════════════════════
// 🔍 تشخيص سريع: افتح /api/health في المتصفح للتأكد من حالة المفتاح
// ═══════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  if (!GROQ_KEY) {
    res.json({ ok: false, problem: 'GROQ_KEY مش معرّف في Environment Variables' });
    return;
  }
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY }
    });
    const body = await r.json().catch(() => null);
    res.json({
      ok: r.ok,
      groq_http_status: r.status,
      key_length: GROQ_KEY.length,
      configured_models: GROQ_MODELS,
      available_model_ids: body?.data ? body.data.map(m => m.id) : null
    });
  } catch (e) {
    res.json({ ok: false, network_error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// تشغيل السيرفر
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎯 ع السريع — المنفذ ${PORT}`);
  console.log(`🤖 Groq API — ${GROQ_MODELS.length} نماذج`);
  console.log(`📊 الأسئلة لكل قسم: ${QUESTIONS_TARGET}`);
  console.log(`🚀 الحد المجاني: 14,400 طلب/يوم\n`);
});