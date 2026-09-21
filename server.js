// ═══════════════════════════════════════════════════════════
// ع السريع — سيرفر Socket.io مع OpenRouter API
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// 🔑 OpenRouter API
// ═══════════════════════════════════════════════════════════
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY = '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';
const OPENROUTER_MODEL = 'anthropic/claude-3.5-sonnet';

const QUESTIONS_TARGET = 40;
const QUESTIONS_MIN_ACCEPT = 25;
const API_TIMEOUT_MS = 120000;

const CATEGORY_DESCRIPTIONS = {
  football: 'كرة القدم: كأس العالم، دوري أبطال أوروبا، اللاعبون التاريخيون، الأندية الكبرى، المدربون، الانتقالات الشهيرة، الأرقام القياسية، الشعارات، التشكيلات، البطولات المحلية والقارية.',
  general:  'معلومات عامة: العلوم، الفيزياء، الكيمياء، الأحياء، الفلك، الفضاء، التاريخ، الجغرافيا، العواصم، الأنهار، الجبال، التقنية، الاختراعات، الرياضيات، الحيوانات.',
  anime:    'الأنمي والمانغا اليابانية: الشخصيات الشهيرة، الأعمال الكلاسيكية والحديثة، المؤلفون، الأحداث الرئيسية، الاستوديوهات المنتجة، المانغا الأصلية، الأفلام.',
  islamic:  'الإسلاميات: القرآن الكريم، التفسير، السيرة النبوية، الصحابة الكرام، الفقه، الأنبياء والرسل، الغزوات، الحديث الشريف، الأئمة، الفتوحات، الحضارة الإسلامية.'
};

const QUESTIONS_CACHE = {};
const CACHE_AGE_MS = 6 * 60 * 60 * 1000;
const CACHE_TIMESTAMPS = {};

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
// تحميل الأسئلة الاحتياطية من الملفات
// ═══════════════════════════════════════════════════════════
const QUESTION_BANK = {};

function loadFallbackQuestions() {
  console.log('\n═══════════════════════════════════════════');
  console.log('📚 تحميل الأسئلة الاحتياطية');
  console.log('═══════════════════════════════════════════');

  UNIQUE_FILES.forEach((filename) => {
    const fullPath = path.resolve(__dirname, filename);

    if (!fs.existsSync(fullPath)) {
      QUESTION_BANK[filename] = [];
      console.log(`   ⚠️  ${filename} → غير موجود`);
      return;
    }

    try {
      let raw = fs.readFileSync(fullPath, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        QUESTION_BANK[filename] = [];
        return;
      }

      const valid = [];
      parsed.forEach((q) => {
        if (!q || typeof q !== 'object') return;
        const text = q.question ?? q.q;
        const choices = q.choices ?? q.c;
        const idx = q.correct_index ?? q.a;
        if (typeof text !== 'string' || !text.trim()) return;
        if (!Array.isArray(choices) || choices.length !== 4) return;
        if (typeof idx !== 'number' || idx < 0 || idx > 3) return;
        valid.push({ question: text.trim(), choices: choices.map(String), correct_index: idx });
      });

      QUESTION_BANK[filename] = valid;
      console.log(`   ${valid.length > 0 ? '✅' : '⚠️ '} ${filename} → ${valid.length} سؤال`);
    } catch (e) {
      console.error(`   ❌ ${filename}: ${e.message}`);
      QUESTION_BANK[filename] = [];
    }
  });
  console.log('');
}
loadFallbackQuestions();

// ═══════════════════════════════════════════════════════════
// بناء prompt الـ API
// ═══════════════════════════════════════════════════════════
function buildQuestionsPrompt(categoryKey, categoryNameAr) {
  const description = CATEGORY_DESCRIPTIONS[categoryKey] || '';

  return `أنت خبير أسئلة مسابقات عربية محترف. أعد ${QUESTIONS_TARGET} سؤال اختيار من متعدد في موضوع "${categoryNameAr}".

الوصف التفصيلي للموضوع: ${description}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
قواعد الصعوبة (موزّعة عشوائياً داخل المصفوفة):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• 40% أسئلة سهلة (سؤال مباشر، يعرفه أي شخص)
• 30% أسئلة متوسطة (يحتاج تفكير أو معلومة معروفة)
• 20% أسئلة صعبة (لا يجيبها إلا المتابع الشغوف)
• 10% أسئلة شبه مستحيلة (تفاصيل نادرة جداً)

⚠️ الترتيب عشوائي تماماً — لا ترتّب حسب الصعوبة. اخلط السهل والصعب معاً.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
شروط إلزامية:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. كل سؤال له 4 خيارات فقط، واحد صحيح.
2. لا تكرر أي سؤال.
3. المعلومات دقيقة وحديثة قدر الإمكان.
4. كل النصوص بالعربية الفصحى.
5. التزم حرفياً بموضوع "${categoryNameAr}" — لا تخرج عن المجال.
6. الخيارات قصيرة (كلمة إلى 5 كلمات).
7. تجنّب الأسئلة المبهمة أو التي لها أكثر من إجابة صحيحة.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
الصيغة المطلوبة (JSON فقط، بدون أي شرح):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{"questions":[{"question":"نص السؤال؟","choices":["خيار1","خيار2","خيار3","خيار4"],"correct_index":0}]}

correct_index: رقم من 0 إلى 3 يشير إلى الخيار الصحيح.`;
}

// ═══════════════════════════════════════════════════════════
// توليد الأسئلة من OpenRouter
// ═══════════════════════════════════════════════════════════
async function generateQuestionsFromAPI(categoryKey) {
  const meta = Object.values(CATEGORY_DISPLAY).find(m => m.key === categoryKey);
  if (!meta) throw new Error('قسم غير معروف: ' + categoryKey);

  const prompt = buildQuestionsPrompt(categoryKey, meta.nameAr);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    console.log(`\n🤖 [API] جاري توليد ${QUESTIONS_TARGET} سؤال لقسم "${meta.nameAr}"...`);
    const startTime = Date.now();

    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENROUTER_KEY,
        'HTTP-Referer': 'https://sahragames.local',
        'X-Title': 'Ala Sareea'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content: 'أنت مساعد خبير بالمسابقات العربية. تُرجع JSON صالحاً فقط، بدون أي كلام إضافي قبل أو بعد.'
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 1.0,
        max_tokens: 16000
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`❌ [API] HTTP ${res.status}:`, errText.slice(0, 400));
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('الرد فارغ');

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
    const seenQuestions = new Set();

    rawQuestions.forEach(q => {
      if (!q || typeof q.question !== 'string') return;
      const qText = q.question.trim();
      if (seenQuestions.has(qText)) return;

      const choices = q.choices || q.options;
      const idx = Number(q.correct_index ?? q.correctIndex ?? q.answer);

      if (!Array.isArray(choices) || choices.length !== 4) return;
      if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;
      if (qText.length < 5) return;

      seenQuestions.add(qText);
      valid.push({
        question: qText,
        choices: choices.map(String),
        correct_index: idx
      });
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [API] تم توليد ${valid.length} سؤال صالح في ${elapsed}s`);

    if (valid.length < QUESTIONS_MIN_ACCEPT) {
      throw new Error(`عدد الأسئلة قليل جداً (${valid.length})`);
    }

    return valid;

  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════
// جلب الأسئلة: كاش → API → fallback JSON
// ═══════════════════════════════════════════════════════════
async function getQuestionsForCategory(categoryKey) {
  const now = Date.now();
  const cached = QUESTIONS_CACHE[categoryKey];
  const cacheAge = now - (CACHE_TIMESTAMPS[categoryKey] || 0);

  if (cached && cached.length >= QUESTIONS_MIN_ACCEPT && cacheAge < CACHE_AGE_MS) {
    const minutesAgo = Math.floor(cacheAge / 60000);
    console.log(`⚡ [CACHE] استخدام ${cached.length} سؤال لقسم "${categoryKey}" (عمرها ${minutesAgo} دقيقة)`);
    return cached;
  }

  try {
    const questions = await generateQuestionsFromAPI(categoryKey);
    QUESTIONS_CACHE[categoryKey] = questions;
    CACHE_TIMESTAMPS[categoryKey] = now;
    return questions;
  } catch (err) {
    console.error(`❌ [API] فشل التوليد: ${err.message}`);

    if (cached && cached.length > 0) {
      console.log(`⚡ [CACHE قديم] استخدام ${cached.length} سؤال`);
      return cached;
    }

    const meta = Object.values(CATEGORY_DISPLAY).find(m => m.key === categoryKey);
    const fallbackFile = meta ? meta.key + '.json' : null;
    const bank = fallbackFile ? (QUESTION_BANK[fallbackFile] || []) : [];

    if (bank.length > 0) {
      console.log(`📁 [Fallback] استخدام ${bank.length} سؤال من الملف`);
      return bank;
    }

    throw new Error('لا توجد أسئلة متاحة لهذا القسم');
  }
}

// ═══════════════════════════════════════════════════════════
// أدوات مساعدة
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

function logOpenRooms(context) {
  const codes = Object.keys(rooms);
  console.log('\n📋 ───── الغرف المفتوحة ─────');
  if (codes.length === 0) {
    console.log('   (لا توجد غرف)');
  } else {
    codes.forEach((code) => {
      const r = rooms[code];
      const players = r.players.map(p => p.name).join(', ') || '(فارغة)';
      console.log(`   🏠 ${code} | ${r.state} | ${r.players.length}/4: ${players}`);
    });
  }
  if (context) console.log(`   📌 ${context}`);
  console.log('   ─────────────────────────\n');
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
    code,
    hostId: hostSocketId,
    players: [],
    isStarted: false,
    state: 'lobby',
    category: null,
    categoryKey: null,
    questionPool: [],
    questionIndex: -1,
    currentQuestion: null,
    removedChoices: new Set(),
    lastCorrectIndex: null,
    roundWinner: null,
    advanceTimer: null,
    generating: false
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
    removedChoices: Array.from(room.removedChoices),
    generating: room.generating
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', getPublicRoom(room));
}

// ═══════════════════════════════════════════════════════════
// منطق الأسئلة
// ═══════════════════════════════════════════════════════════
function pickNextQuestion(room) {
  if (room.questionIndex + 1 >= room.questionPool.length) {
    room.questionPool = shuffleArray(room.questionPool).map(shuffleQuestionChoices);
    room.questionIndex = -1;
    console.log(`🔁 [${room.code}] إعادة خلط الأسئلة`);
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

// ═══════════════════════════════════════════════════════════
// Socket.io
// ═══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`\n🔌 اتصال: ${socket.id}`);

  // ─────────────────────────────────────────
  // إنشاء غرفة
  // ─────────────────────────────────────────
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

    console.log(`🏠 [${room.code}] غرفة جديدة بواسطة "${name.trim()}"`);
    socket.emit('room_created', { code: room.code });
    broadcastRoom(room);
    logOpenRooms('بعد الإنشاء');
  });

  // ─────────────────────────────────────────
  // الانضمام
  // ─────────────────────────────────────────
  socket.on('join_room', ({ code, name, avatar }) => {
    if (!name || !name.trim()) {
      return socket.emit('error_msg', { msg: 'اكتب اسمك!' });
    }

    const roomCode = normalizeRoomCode(code);
    if (!roomCode) {
      return socket.emit('error_msg', { msg: 'اكتب كود الغرفة!' });
    }

    const room = rooms[roomCode];
    if (!room) {
      return socket.emit('error_msg', { msg: `الغرفة "${roomCode}" غير موجودة!` });
    }

    if (room.isStarted || !JOINABLE_STATES.has(room.state)) {
      return socket.emit('error_msg', { msg: 'اللعبة بدأت بالفعل!' });
    }

    if (room.players.length >= CONSTANTS.MAX_PLAYERS) {
      return socket.emit('error_msg', { msg: 'الغرفة ممتلئة!' });
    }

    const cleanName = name.trim().slice(0, 15);
    if (room.players.some(p => p.name === cleanName)) {
      return socket.emit('error_msg', { msg: 'هذا الاسم مستخدم!' });
    }

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

    console.log(`✅ [${room.code}] "${cleanName}" انضم (${room.players.length}/4)`);
    socket.emit('room_joined', { code: room.code });
    broadcastRoom(room);
  });

  // ─────────────────────────────────────────
  // اختيار القسم
  // ─────────────────────────────────────────
  socket.on('select_category', ({ category }) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return socket.emit('error_msg', { msg: 'الغرفة غير موجودة!' });
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف!' });
    if (room.isStarted || !JOINABLE_STATES.has(room.state)) {
      return socket.emit('error_msg', { msg: 'لا يمكن التغيير بعد البدء!' });
    }

    const normalized = normalizeCategory(category);
    let filename = CATEGORY_MAP[normalized];
    if (!filename && /^[a-z]+$/.test(normalized)) {
      const guess = `${normalized}.json`;
      if (UNIQUE_FILES.includes(guess)) filename = guess;
    }

    if (!filename) {
      return socket.emit('error_msg', { msg: `قسم غير معروف: "${category}"` });
    }

    room.category = filename;
    room.categoryKey = CATEGORY_DISPLAY[filename].key;

    console.log(`🎯 [${room.code}] القسم: ${room.categoryKey}`);
    broadcastRoom(room);
  });

  // ─────────────────────────────────────────
  // بدء اللعبة — توليد الأسئلة
  // ─────────────────────────────────────────
  socket.on('start_game', async () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return socket.emit('error_msg', { msg: 'الغرفة غير موجودة!' });
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف!' });
    if (room.isStarted) return socket.emit('error_msg', { msg: 'اللعبة بدأت بالفعل!' });
    if (room.players.length < CONSTANTS.MIN_PLAYERS) {
      return socket.emit('error_msg', { msg: `محتاج ${CONSTANTS.MIN_PLAYERS} لاعبين على الأقل!` });
    }
    if (!room.category) return socket.emit('error_msg', { msg: 'اختر القسم أولاً!' });
    if (room.generating) return;

    // نقفل الغرفة أثناء التوليد
    room.isStarted = true;
    room.state = 'generating';
    room.generating = true;

    io.to(room.code).emit('generating_questions', {
      categoryKey: room.categoryKey,
      categoryMeta: CATEGORY_DISPLAY[room.category]
    });
    broadcastRoom(room);

    console.log(`\n⏳ [${room.code}] جاري توليد الأسئلة...`);

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
        targetScore: CONSTANTS.TARGET_SCORE,
        questionsReady: true
      });
      broadcastRoom(room);

      setTimeout(() => sendNextQuestion(room), 400);

    } catch (err) {
      console.error(`❌ [${room.code}] فشل التوليد:`, err.message);

      room.generating = false;
      room.isStarted = false;
      room.state = 'category';

      io.to(room.code).emit('generating_failed', {
        message: 'تعذّر توليد الأسئلة. حاول مرة أخرى.'
      });
      broadcastRoom(room);
    }
  });

  // ─────────────────────────────────────────
  // تقديم إجابة
  // ─────────────────────────────────────────
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

      console.log(`✅ [${room.code}] ${player.name} +1 (${player.score})`);

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

      console.log(`❌ [${room.code}] ${player.name} أخطأ — الخيار ${choiceIndex}`);

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

  // ─────────────────────────────────────────
  // إعادة اللعب
  // ─────────────────────────────────────────
  socket.on('play_again', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: 'فقط المضيف!' });
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

  // ─────────────────────────────────────────
  // خروج
  // ─────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms[code];
    if (!room) return;

    const leaving = room.players.find(p => p.socketId === socket.id);
    console.log(`🔌 خروج: ${socket.id} (${leaving ? leaving.name : '?'}) من ${code}`);

    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length === 0) {
      clearTimeout(room.advanceTimer);
      delete rooms[code];
      console.log(`🗑️ [${code}] حُذفت الغرفة`);
      logOpenRooms('بعد الحذف');
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
// تشغيل السيرفر
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎯 ع السريع — يعمل على المنفذ ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🤖 نموذج: ${OPENROUTER_MODEL}`);
  console.log(`📊 الهدف: ${CONSTANTS.TARGET_SCORE} نقاط`);
  console.log(`⏱️  كاش الأسئلة: ${CACHE_AGE_MS / 3600000} ساعات\n`);
});