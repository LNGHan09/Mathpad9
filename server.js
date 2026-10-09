require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const rateLimit = require('express-rate-limit');
const { questions, publicQuestion } = require('./questions');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const COOKIE_NAME = 'mathai_session';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET.startsWith('REPLACE_WITH_')) {
  console.error('Thiếu JWT_SECRET an toàn. Hãy tạo chuỗi ngẫu nhiên dài ít nhất 32 ký tự trong file .env.');
  process.exit(1);
}

const databasePath = process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : path.join(__dirname, 'mathai.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  grade INTEGER NOT NULL DEFAULT 9,
  target_score REAL NOT NULL DEFAULT 7,
  school TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  leaderboard_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS quiz_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  earned_points REAL NOT NULL,
  max_points REAL NOT NULL,
  score10 REAL NOT NULL,
  answered_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  skill TEXT NOT NULL,
  section TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  points_earned REAL NOT NULL DEFAULT 0,
  points_possible REAL NOT NULL,
  answer_json TEXT,
  seconds INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attempts_user_created ON attempts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_user_skill ON attempts(user_id, skill);
CREATE TABLE IF NOT EXISTS skill_stats (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  topic TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  avg_seconds REAL NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, skill)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_user_id ON chat_messages(user_id, id);
CREATE TABLE IF NOT EXISTS study_plans (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.' } });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Bạn đã gửi nhiều yêu cầu AI trong thời gian ngắn. Hãy thử lại sau một phút.' } });

app.disable('x-powered-by');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"],
    objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"],
    upgradeInsecureRequests: IS_PRODUCTION ? [] : null
  } }
}));
app.use(cookieParser());
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite === 'cross-site') return res.status(403).json({ error: 'Yêu cầu từ nguồn bên ngoài bị từ chối.' });
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ.' }); }
      catch { return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ.' }); }
    }
  }
  next();
});
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function cleanUser(row) {
  return {
    id: row.id, email: row.email, displayName: row.display_name, grade: row.grade,
    targetScore: row.target_score, school: row.school || '', city: row.city || '',
    leaderboardOptIn: Boolean(row.leaderboard_opt_in), createdAt: row.created_at
  };
}
function makeToken(user) {
  return jwt.sign({ sub: String(user.id) }, JWT_SECRET, { expiresIn: '7d', issuer: 'math-adaptive-ai' });
}
function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: IS_PRODUCTION, sameSite: 'strict', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000
  });
}
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Bạn cần đăng nhập để tiếp tục.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { issuer: 'math-adaptive-ai' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(decoded.sub));
    if (!user) return res.status(401).json({ error: 'Tài khoản không còn tồn tại. Hãy đăng nhập lại.' });
    req.user = user;
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: IS_PRODUCTION, path: '/' });
    return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' });
  }
}
function aiReady(res) {
  if (!openai) {
    res.status(503).json({ error: 'AI chưa được cấu hình. Hãy thêm OPENAI_API_KEY vào file .env ở máy chủ rồi khởi động lại web.' });
    return false;
  }
  return true;
}
function errResponse(res, error) {
  console.error('[request-error]', error?.message || error);
  if (error?.status === 401) return res.status(502).json({ error: 'Khóa API AI không hợp lệ hoặc chưa được cấp quyền. Hãy kiểm tra cấu hình máy chủ.' });
  if (error?.status === 429) return res.status(429).json({ error: 'Dịch vụ AI đang giới hạn yêu cầu hoặc hết hạn mức. Hãy kiểm tra hạn mức API và thử lại sau.' });
  res.status(500).json({ error: 'Có lỗi khi xử lý yêu cầu. Dữ liệu học tập của bạn vẫn được giữ nguyên; hãy thử lại.' });
}
async function runAI({ instructions, input, maxOutputTokens = 900 }) {
  if (!openai) throw new Error('OPENAI_API_KEY is not configured');
  const response = await openai.responses.create({
    model: AI_MODEL,
    instructions,
    input,
    max_output_tokens: maxOutputTokens
  });
  return (response.output_text || '').trim() || 'Mình chưa tạo được câu trả lời trong lượt này. Bạn thử diễn đạt lại câu hỏi nhé.';
}
function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\u00a0]/g, '').replace(/−/g, '-').replace(/,/g, ',');
}
function answerMatches(q, rawAnswer) {
  if (q.type === 'graph') {
    const points = Array.isArray(rawAnswer) ? rawAnswer : [];
    const fn = q.graphFunction;
    const onLine = points.filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) && Math.abs(Number(p.y) - (fn.m * Number(p.x) + fn.b)) <= 0.55);
    const distinctXs = new Set(onLine.map(p => Math.round(Number(p.x) * 10) / 10));
    return { correct: distinctXs.size >= 2, fraction: Math.min(1, distinctXs.size / 2) };
  }
  if (q.type === 'match') {
    const submitted = rawAnswer && typeof rawAnswer === 'object' ? rawAnswer : {};
    const entries = Object.entries(q.answer);
    const correct = entries.filter(([k,v]) => normalized(submitted[k]) === normalized(v)).length;
    return { correct: correct === entries.length, fraction: entries.length ? correct / entries.length : 0 };
  }
  const value = normalized(rawAnswer);
  const accepted = (q.accepted || [q.answer]).map(normalized);
  const isCorrect = accepted.includes(value) || normalized(q.answer) === value;
  return { correct: isCorrect, fraction: isCorrect ? 1 : 0 };
}
function getSkillSnapshot(userId) {
  return db.prepare(`SELECT skill, topic, attempts, correct, avg_seconds, last_error,
    ROUND(100.0 * (correct + 1.0) / (attempts + 2.0), 1) AS accuracy,
    updated_at FROM skill_stats WHERE user_id = ? ORDER BY attempts DESC, skill ASC`).all(userId).map(s => ({
      skill: s.skill, topic: s.topic, attempts: s.attempts, correct: s.correct,
      accuracy: Number(s.accuracy), avgSeconds: Math.round(s.avg_seconds || 0), lastError: s.last_error, updatedAt: s.updated_at
    }));
}
function getProfileSnapshot(user) {
  const recent = db.prepare(`SELECT score10, total_count, answered_count, created_at FROM quiz_sessions
    WHERE user_id = ? ORDER BY id DESC LIMIT 8`).all(user.id);
  const skillStats = getSkillSnapshot(user.id);
  const totalAttempts = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ?').get(user.id).n;
  return {
    displayName: user.display_name, grade: user.grade, targetScore: user.target_score,
    school: user.school || '', city: user.city || '', totalAttempts,
    recentScores: recent.map(r => ({ score: Number(r.score10), total: r.total_count, answered: r.answered_count, date: r.created_at })),
    skills: skillStats
  };
}
function getPublicQuestionById(id) { return questions.find(q => q.id === id); }
function displayCorrectAnswer(q) {
  if (q.type === 'graph') return 'Đặt ít nhất hai điểm trên đường thẳng y = 2x − 1; ví dụ (0; −1) và (1; 1).';
  if (q.type === 'match') return Object.entries(q.answer || {}).map(([key, value]) => `${Number(key) + 1}. ${value}`).join(' · ');
  if (q.choices) return q.choices.find(choice => String(choice.value) === String(q.answer))?.label || q.answer;
  return q.answer;
}
function chooseQuestionsForUser(user) {
  const target = Number(user.target_score || 7);
  const counts = target <= 6 ? { foundation: 5, application: 3, challenge: 2 }
    : target <= 8 ? { foundation: 4, application: 4, challenge: 2 }
      : { foundation: 3, application: 4, challenge: 3 };
  const skillRows = getSkillSnapshot(user.id);
  const skillMap = new Map(skillRows.map(s => [s.skill, s.accuracy / 100]));
  const recentIds = new Set(db.prepare('SELECT question_id FROM attempts WHERE user_id = ? ORDER BY id DESC LIMIT 8').all(user.id).map(a => a.question_id));
  const randomRanked = (items, count) => {
    let eligible = items.filter(q => !recentIds.has(q.id));
    if (eligible.length < count) eligible = items;
    return [...eligible].sort((a,b) => {
      const scoreA = (skillMap.has(a.skill) ? skillMap.get(a.skill) : 0.48) + (Math.random() * 0.28 - 0.14);
      const scoreB = (skillMap.has(b.skill) ? skillMap.get(b.skill) : 0.48) + (Math.random() * 0.28 - 0.14);
      return scoreA - scoreB;
    }).slice(0, count);
  };
  return ['foundation','application','challenge'].flatMap(section => randomRanked(questions.filter(q => q.section === section), counts[section]));
}

app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(openai), model: openai ? AI_MODEL : null }));

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const displayName = String(req.body?.displayName || '').trim().slice(0, 50);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const requestedGrade = Number(req.body?.grade || 9);
  if (!Number.isInteger(requestedGrade) || requestedGrade < 6 || requestedGrade > 12) return res.status(400).json({ error: 'Lớp học phải là số nguyên từ 6 đến 12.' });
  const grade = requestedGrade;
  if (displayName.length < 2) return res.status(400).json({ error: 'Tên hiển thị cần có ít nhất 2 ký tự.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) return res.status(400).json({ error: 'Email chưa đúng định dạng.' });
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: 'Mật khẩu cần có ít nhất 8 ký tự và tối đa 72 byte UTF-8.' });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (email,password_hash,display_name,grade) VALUES (?,?,?,?)').run(email, passwordHash, displayName, grade);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    setAuthCookie(res, makeToken(user));
    res.status(201).json({ user: cleanUser(user) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email này đã có tài khoản. Hãy đăng nhập hoặc dùng email khác.' });
    errResponse(res, error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email hoặc mật khẩu chưa chính xác.' });
  setAuthCookie(res, makeToken(user));
  res.json({ user: cleanUser(user) });
});
app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: IS_PRODUCTION, path: '/' });
  res.json({ ok: true });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: cleanUser(req.user) }));
app.delete('/api/auth/account', requireAuth, async (req, res) => {
  const password = String(req.body?.password || '');
  if (!(await bcrypt.compare(password, req.user.password_hash))) return res.status(401).json({ error: 'Mật khẩu chưa chính xác.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: IS_PRODUCTION, path: '/' });
  res.json({ ok: true });
});

app.get('/api/profile', requireAuth, (req, res) => res.json({ user: cleanUser(req.user), skills: getSkillSnapshot(req.user.id) }));
app.patch('/api/profile', requireAuth, (req, res) => {
  const displayName = String(req.body?.displayName ?? req.user.display_name).trim().slice(0,50);
  const grade = Math.min(12, Math.max(6, Number(req.body?.grade ?? req.user.grade)));
  const targetScore = Math.min(10, Math.max(1, Number(req.body?.targetScore ?? req.user.target_score)));
  const school = String(req.body?.school ?? req.user.school).trim().slice(0,100);
  const city = String(req.body?.city ?? req.user.city).trim().slice(0,100);
  const optIn = req.body?.leaderboardOptIn === undefined ? req.user.leaderboard_opt_in : (req.body.leaderboardOptIn ? 1 : 0);
  if (displayName.length < 2 || !Number.isFinite(grade) || !Number.isFinite(targetScore)) return res.status(400).json({ error: 'Thông tin hồ sơ chưa hợp lệ.' });
  db.prepare('UPDATE users SET display_name=?, grade=?, target_score=?, school=?, city=?, leaderboard_opt_in=? WHERE id=?')
    .run(displayName, grade, targetScore, school, city, optIn, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ user: cleanUser(user) });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const userId = req.user.id;
  const sessions = db.prepare('SELECT * FROM quiz_sessions WHERE user_id=? ORDER BY id DESC LIMIT 8').all(userId);
  const allScores = db.prepare('SELECT COUNT(*) AS n, AVG(score10) AS avg, MAX(score10) AS best FROM quiz_sessions WHERE user_id=?').get(userId);
  const totalAnswered = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id=?').get(userId).n;
  const correctCount = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id=? AND is_correct=1').get(userId).n;
  const skills = getSkillSnapshot(userId);
  const weakest = [...skills].filter(s => s.attempts >= 2).sort((a,b)=>a.accuracy-b.accuracy).slice(0,3);
  const plan = db.prepare('SELECT plan_text,updated_at FROM study_plans WHERE user_id=?').get(userId);
  res.json({
    user: cleanUser(req.user), aiConfigured: Boolean(openai),
    stats: { quizzes: allScores.n, totalAnswered, accuracy: totalAnswered ? Math.round(correctCount/totalAnswered*100) : 0,
      averageScore: allScores.avg == null ? null : Number(Number(allScores.avg).toFixed(1)), bestScore: allScores.best == null ? null : Number(Number(allScores.best).toFixed(1)),
      latestScore: sessions.length ? Number(sessions[0].score10.toFixed(1)) : null },
    skills, weakest, recentSessions: sessions.map(s=>({id:s.id,score:Number(s.score10.toFixed(1)),answered:s.answered_count,total:s.total_count,date:s.created_at})),
    plan: plan ? { text: plan.plan_text, updatedAt: plan.updated_at } : null
  });
});

app.post('/api/quiz/start', requireAuth, (req, res) => {
  const selected = chooseQuestionsForUser(req.user);
  res.json({ questions: selected.map(publicQuestion), targetScore: req.user.target_score,
    note: 'Đề gồm 3 phần, tăng dần độ khó. Hệ thống có ưu tiên kỹ năng bạn cần luyện, đồng thời vẫn kiểm tra đủ các nhóm kiến thức.' });
});

app.post('/api/quiz/submit', requireAuth, (req, res) => {
  const answers = req.body?.answers;
  const times = req.body?.times || {};
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return res.status(400).json({ error: 'Dữ liệu bài làm chưa hợp lệ.' });
  const ids = Object.keys(answers);
  if (ids.length < 1 || ids.length > 20 || ids.some(id => !getPublicQuestionById(id))) return res.status(400).json({ error: 'Bài làm không hợp lệ hoặc có câu hỏi không tồn tại.' });
  const selected = ids.map(id => getPublicQuestionById(id));
  let earned = 0, maximum = 0, answeredCount = 0;
  const results = selected.map(q => {
    const raw = answers[q.id];
    const hasAnswer = q.type === 'graph' ? Array.isArray(raw) && raw.length > 0
      : q.type === 'match' ? raw && typeof raw === 'object' && Object.keys(raw).length > 0
        : String(raw ?? '').trim().length > 0;
    const grade = answerMatches(q, raw);
    const qEarned = q.points * grade.fraction;
    earned += qEarned; maximum += q.points;
    if (hasAnswer) answeredCount++;
    const seconds = Math.min(3600, Math.max(0, Math.floor(Number(times[q.id] || 0))));
    return { questionId:q.id, prompt:q.prompt, topic:q.topic, skill:q.skill, section:q.section, difficulty:q.difficulty,
      type:q.type, userAnswer: raw ?? null, correct: grade.correct, fraction: grade.fraction,
      pointsEarned: Number(qEarned.toFixed(2)), pointsPossible:q.points, explanation:q.explanation,
      correctAnswer: displayCorrectAnswer(q),
      seconds, errorType: q.errorType || 'Cần xem lại lời giải' };
  });
  const score10 = maximum ? Math.round((earned / maximum * 10) * 10) / 10 : 0;
  const commit = db.transaction(() => {
    const session = db.prepare('INSERT INTO quiz_sessions(user_id,earned_points,max_points,score10,answered_count,total_count) VALUES(?,?,?,?,?,?)')
      .run(req.user.id, earned, maximum, score10, answeredCount, selected.length);
    for (const r of results) {
      const q = getPublicQuestionById(r.questionId);
      db.prepare(`INSERT INTO attempts(user_id,session_id,question_id,topic,skill,section,difficulty,is_correct,points_earned,points_possible,answer_json,seconds,error_type)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, Number(session.lastInsertRowid), q.id, q.topic, q.skill, q.section, q.difficulty,
          r.correct ? 1 : 0, r.pointsEarned, r.pointsPossible, JSON.stringify(r.userAnswer), r.seconds, r.correct ? '' : r.errorType);
      const previous = db.prepare('SELECT attempts,correct,avg_seconds FROM skill_stats WHERE user_id=? AND skill=?').get(req.user.id, q.skill);
      const attemptsCount = (previous?.attempts || 0) + 1;
      const correctCount = (previous?.correct || 0) + (r.correct ? 1 : 0);
      const avgSeconds = ((previous?.avg_seconds || 0) * (attemptsCount - 1) + r.seconds) / attemptsCount;
      db.prepare(`INSERT INTO skill_stats(user_id,skill,topic,attempts,correct,avg_seconds,last_error,updated_at)
        VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(user_id,skill) DO UPDATE SET topic=excluded.topic,attempts=excluded.attempts,correct=excluded.correct,
        avg_seconds=excluded.avg_seconds,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP`)
        .run(req.user.id, q.skill, q.topic, attemptsCount, correctCount, avgSeconds, r.correct ? (previous?.last_error || '') : r.errorType);
    }
    return Number(session.lastInsertRowid);
  });
  const sessionId = commit();
  const misses = results.filter(r => !r.correct);
  const skillMisses = {};
  for (const r of misses) skillMisses[r.skill] = (skillMisses[r.skill] || 0) + 1;
  const focus = Object.entries(skillMisses).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([skill])=>skill);
  res.json({ sessionId, score10, earnedPoints:Number(earned.toFixed(2)), maxPoints:maximum, answeredCount, totalCount:selected.length,
    results, focusSkills:focus, message: score10 >= Number(req.user.target_score) ? 'Bạn đã chạm mục tiêu điểm hiện tại. Hãy củng cố độ ổn định và thử mức khó hơn.' : 'Bài làm đã được lưu. Lần luyện tiếp theo sẽ ưu tiên các kỹ năng có tín hiệu cần củng cố.' });
});

app.get('/api/history', requireAuth, (req, res) => {
  const sessions = db.prepare('SELECT * FROM quiz_sessions WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.json({ sessions: sessions.map(s=>({id:s.id,score:Number(s.score10.toFixed(1)),answered:s.answered_count,total:s.total_count,date:s.created_at})),
    attempts: db.prepare('SELECT question_id,topic,skill,is_correct,points_earned,points_possible,error_type,seconds,created_at FROM attempts WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id) });
});

app.get('/api/leaderboard', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT u.display_name,u.school,u.city,ROUND(AVG(q.score10),1) AS average_score,MAX(q.score10) AS best_score,COUNT(q.id) AS quizzes
    FROM users u JOIN quiz_sessions q ON q.user_id=u.id WHERE u.leaderboard_opt_in=1
    GROUP BY u.id HAVING COUNT(q.id)>=1 ORDER BY average_score DESC,quizzes DESC LIMIT 50`).all();
  res.json({ entries: rows.map((r,i)=>({rank:i+1,name:r.display_name,school:r.school||'Chưa cập nhật',city:r.city||'',averageScore:Number(r.average_score),bestScore:Number(Number(r.best_score).toFixed(1)),quizzes:r.quizzes})),
    note: 'Bảng xếp hạng chỉ hiển thị người đã chủ động bật chia sẻ trong hồ sơ. Không hiển thị email.' });
});

const TUTOR_INSTRUCTIONS = `Bạn là MathMate, gia sư Toán tiếng Việt dành cho học sinh THCS/THPT. Hãy giải thích rõ, kiên nhẫn, không chê bai học sinh. Cá nhân hóa theo hồ sơ và lịch sử bài làm được cung cấp. Khi phù hợp, gợi ý một bước nhỏ trước khi đưa lời giải đầy đủ; nếu học sinh yêu cầu lời giải chi tiết thì trình bày từng bước, chỉ rõ điều kiện và lỗi hay gặp. Không khẳng định chẩn đoán năng lực chắc chắn khi dữ liệu ít; hãy nêu mức độ chưa chắc chắn. Dùng định dạng dễ đọc, ký hiệu Toán chuẩn và ví dụ phù hợp chương trình Việt Nam. Không bịa dữ liệu điểm số.`;

app.get('/api/ai/status', requireAuth, (req, res) => res.json({ configured: Boolean(openai), model: openai ? AI_MODEL : null }));
app.post('/api/ai/tutor', requireAuth, aiLimiter, async (req, res) => {
  if (!aiReady(res)) return;
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 5000) return res.status(400).json({ error: 'Tin nhắn phải có nội dung và không vượt quá 5.000 ký tự.' });
  try {
    db.prepare('INSERT INTO chat_messages(user_id,role,content) VALUES(?,?,?)').run(req.user.id, 'user', message);
    const history = db.prepare('SELECT role,content FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 12').all(req.user.id).reverse();
    const profile = getProfileSnapshot(req.user);
    const input = [
      { role:'user', content:`HỒ SƠ HỌC SINH RIÊNG (chỉ để cá nhân hóa, không hiển thị lại nguyên xi):\n${JSON.stringify(profile)}\nHãy dựa vào bằng chứng vừa đủ; nếu chưa có dữ liệu thì hỏi thêm hoặc nói rõ.` },
      ...history.map(m=>({role:m.role,content:m.content}))
    ];
    const text = await runAI({ instructions:TUTOR_INSTRUCTIONS, input, maxOutputTokens:1000 });
    db.prepare('INSERT INTO chat_messages(user_id,role,content) VALUES(?,?,?)').run(req.user.id, 'assistant', text);
    res.json({ reply:text });
  } catch (error) { errResponse(res,error); }
});
app.get('/api/ai/chat-history', requireAuth, (req, res) => {
  const messages = db.prepare('SELECT role,content,created_at FROM chat_messages WHERE user_id=? ORDER BY id DESC LIMIT 40').all(req.user.id).reverse();
  res.json({ messages });
});
app.delete('/api/ai/chat-history', requireAuth, (req, res) => {
  db.prepare('DELETE FROM chat_messages WHERE user_id=?').run(req.user.id);
  res.json({ ok:true });
});
app.post('/api/ai/diagnose', requireAuth, aiLimiter, async (req, res) => {
  if (!aiReady(res)) return;
  try {
    const profile = getProfileSnapshot(req.user);
    const text = await runAI({ instructions:`${TUTOR_INSTRUCTIONS}\nBạn là trợ lý phân tích dữ liệu học tập. Hãy viết chẩn đoán theo 4 mục: (1) dấu hiệu từ dữ liệu, (2) kỹ năng ưu tiên, (3) giả thuyết nguyên nhân cần kiểm chứng, (4) bài kiểm tra nhỏ tiếp theo. Nêu số lần mẫu; không suy luận quá mức, không dán nhãn cố định cho học sinh.`,
      input:`Phân tích hồ sơ sau và viết báo cáo ngắn, có căn cứ:\n${JSON.stringify(profile)}`, maxOutputTokens:900 });
    res.json({ report:text });
  } catch (error) { errResponse(res,error); }
});
app.post('/api/ai/plan', requireAuth, aiLimiter, async (req, res) => {
  if (!aiReady(res)) return;
  const target = Math.min(10,Math.max(1,Number(req.body?.targetScore || req.user.target_score)));
  const weeks = Math.min(16,Math.max(2,Number(req.body?.weeks || 8)));
  try {
    const profile = getProfileSnapshot(req.user);
    const plan = await runAI({ instructions:`${TUTOR_INSTRUCTIONS}\nTạo lộ trình học Toán thực tế cho học sinh Việt Nam. Cấu trúc: mục tiêu đo được; kế hoạch theo tuần; lịch học 5 ngày/tuần, mỗi buổi 25-45 phút; quy tắc ôn lại lỗi; kiểm tra định kỳ; tiêu chí điều chỉnh. Ưu tiên kỹ năng yếu có dữ liệu, nhưng vẫn giữ cân bằng kiến thức. Không hứa chắc chắn đạt điểm; tránh lịch quá tải. Trả lời bằng tiếng Việt, Markdown gọn và có thể thực hiện.`,
      input:`Tạo lộ trình ${weeks} tuần với mục tiêu ${target}/10. Hồ sơ và lịch sử làm bài riêng của học sinh:\n${JSON.stringify(profile)}`, maxOutputTokens:1400 });
    db.prepare(`INSERT INTO study_plans(user_id,plan_text,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET plan_text=excluded.plan_text,updated_at=CURRENT_TIMESTAMP`).run(req.user.id,plan);
    res.json({ plan });
  } catch (error) { errResponse(res,error); }
});
app.post('/api/ai/error-hunt', requireAuth, aiLimiter, async (req, res) => {
  if (!aiReady(res)) return;
  const skillNames = new Set(questions.map(q=>q.skill));
  const requested = String(req.body?.skill || '').trim();
  const stats = getSkillSnapshot(req.user.id);
  const weakest = [...stats].sort((a,b)=>a.accuracy-b.accuracy)[0]?.skill;
  const skill = skillNames.has(requested) ? requested : (weakest || 'Phương trình bậc nhất');
  try {
    const content = await runAI({ instructions:`Bạn là người thiết kế hoạt động “Săn lỗi sai” trong giáo dục Toán. Tạo đúng một bài Toán phù hợp học sinh lớp ${req.user.grade}. Bài phải có: Đề bài; Lời giải của bạn học sinh (cố tình chứa đúng MỘT lỗi sai hợp lý, không lộ đáp án); Nhiệm vụ tìm và giải thích lỗi. Chỉ tạo bài và lời giải sai có chủ đích; chưa cung cấp lời giải đúng cho đến khi học sinh yêu cầu ở lượt chat sau. Không tạo lỗi vô lý.`,
      input:`Tập trung vào kỹ năng: ${skill}. Dữ liệu gần đây của học sinh: ${JSON.stringify(stats.filter(s=>s.skill===skill))}. Tạo hoạt động bằng tiếng Việt.`, maxOutputTokens:700 });
    res.json({ skill, activity:content });
  } catch (error) { errResponse(res,error); }
});
app.post('/api/ai/analyze-image', requireAuth, aiLimiter, async (req, res) => {
  if (!aiReady(res)) return;
  const imageData = String(req.body?.imageData || '');
  const questionText = String(req.body?.questionText || 'Hãy phân tích lời giải Toán trong ảnh.').slice(0,2500);
  const match = imageData.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: 'Ảnh phải là PNG, JPG hoặc WEBP hợp lệ.' });
  if (match[2].length > 7_000_000) return res.status(413).json({ error: 'Ảnh vượt quá kích thước cho phép. Hãy chọn ảnh nhỏ hơn 5 MB.' });
  try {
    const profile = getProfileSnapshot(req.user);
    const input = [{ role:'user', content:[
      { type:'input_text', text:`${questionText}\nHãy đọc chữ viết trong ảnh cẩn thận. Tách rõ: (1) phần bạn đọc được và chỗ chưa chắc, (2) các bước đúng, (3) lỗi sai cụ thể nếu có, (4) hướng sửa và lời giải mẫu, (5) một bài nhỏ để tự kiểm tra. Không đoán nội dung chữ mờ; yêu cầu ảnh rõ hơn nếu cần. Ngữ cảnh hồ sơ: ${JSON.stringify(profile.skills.slice(0,8))}` },
      { type:'input_image', image_url:imageData, detail:'high' }
    ] }];
    const analysis = await runAI({ instructions:TUTOR_INSTRUCTIONS, input, maxOutputTokens:1100 });
    res.json({ analysis });
  } catch (error) { errResponse(res,error); }
});

// API lỗi không trả stack trace về trình duyệt.
app.use((err, _req, res, _next) => {
  console.error('[unhandled-error]', err?.message || err);
  res.status(500).json({ error:'Máy chủ gặp lỗi khi xử lý yêu cầu.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MathMate đang chạy tại http://localhost:${PORT}`);
  console.log(`AI: ${openai ? `đã cấu hình (${AI_MODEL})` : 'chưa cấu hình — hãy điền OPENAI_API_KEY trong .env'}`);
});
