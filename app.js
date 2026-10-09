/* MathMate front-end: private account context, adaptive quizzes, progress and AI tools. */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    user: null,
    page: 'dashboard',
    quiz: null,
    quizTimer: null,
    toastTimer: null,
    modalAction: null,
    isBusy: false,
    aiConfigured: false,
  };

  const PAGE_TITLES = {
    dashboard: 'Tổng quan', practice: 'Luyện đề thích ứng', tutor: 'Gia sư AI',
    roadmap: 'Lộ trình cá nhân', history: 'Lịch sử & lỗi sai',
    leaderboard: 'Bảng thi đua', profile: 'Hồ sơ & cài đặt'
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  // A deliberately small Markdown renderer. HTML is escaped before formatting, so AI/user text stays inert.
  function markdown(value) {
    const raw = esc(value).replace(/\r\n?/g, '\n');
    const lines = raw.split('\n');
    const out = [];
    let inList = false;
    const inline = line => line
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>');
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const line of lines) {
      const trimmed = line.trim();
      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
      const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
      if (heading) {
        closeList();
        const level = Math.min(3, heading[1].length + 1);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${inline(bullet[1])}</li>`);
      } else {
        closeList();
        if (!trimmed) out.push('<div class="md-spacer"></div>');
        else out.push(`<p>${inline(trimmed)}</p>`);
      }
    }
    closeList();
    return out.join('');
  }

  function toast(message, type = 'success') {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', type === 'error');
    el.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.remove('show'), 3700);
  }

  function setBusy(button, busy, label = 'Đang xử lý…') {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.innerHTML;
      button.disabled = true;
      button.classList.add('is-loading');
      button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(label)}`;
    } else {
      button.disabled = false;
      button.classList.remove('is-loading');
      if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }

  async function api(url, options = {}) {
    const opts = { method: 'GET', credentials: 'same-origin', ...options };
    const headers = new Headers(opts.headers || {});
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
      headers.set('Content-Type', 'application/json');
      opts.body = JSON.stringify(opts.body);
    }
    opts.headers = headers;
    const response = await fetch(url, opts);
    let data = {};
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await response.json().catch(() => ({}));
    } else {
      data = { error: await response.text().catch(() => 'Không đọc được phản hồi máy chủ.') };
    }
    if (!response.ok) {
      const error = new Error(data.error || `Yêu cầu thất bại (${response.status}).`);
      error.status = response.status;
      if (response.status === 401 && state.user) showAuth();
      throw error;
    }
    return data;
  }

  function friendlyError(error) {
    if (error?.status === 503) return 'AI chưa được cấu hình. Bạn vẫn có thể luyện đề và lưu tiến độ. Hãy thêm OPENAI_API_KEY ở máy chủ để bật gia sư AI.';
    if (error?.status === 429) return error.message || 'Bạn gửi yêu cầu quá nhanh. Hãy đợi một chút rồi thử lại.';
    return error?.message || 'Đã xảy ra lỗi. Vui lòng thử lại.';
  }

  function showAuth(mode = 'login') {
    state.user = null;
    state.quiz = null;
    stopQuizTimer();
    $('#authScreen').classList.remove('hidden');
    $('#appShell').classList.add('hidden');
    switchAuth(mode);
  }

  function switchAuth(mode) {
    const login = mode === 'login';
    $('#loginForm').classList.toggle('hidden', !login);
    $('#registerForm').classList.toggle('hidden', login);
    $('#loginTab').classList.toggle('active', login);
    $('#registerTab').classList.toggle('active', !login);
    $('#authTitle').textContent = login ? 'Đăng nhập tài khoản' : 'Tạo không gian học tập';
    $('#authSubtitle').textContent = login ? 'Tiếp tục hành trình chinh phục Toán học.' : 'Mỗi tài khoản có hồ sơ, lịch sử và gia sư AI theo ngữ cảnh riêng.';
  }

  function initials(name) {
    return String(name || 'M').trim().split(/\s+/).slice(-2).map(s => s[0] || '').join('').toUpperCase() || 'M';
  }

  function updateUserChrome(user) {
    if (!user) return;
    $('#sidebarAvatar').textContent = initials(user.displayName);
    $('#topAvatar').textContent = initials(user.displayName);
    $('#sidebarName').textContent = user.displayName;
    $('#sidebarGrade').textContent = `Lớp ${user.grade} · Mục tiêu ${Number(user.targetScore).toLocaleString('vi-VN')}/10`;
    $('#welcomeName').textContent = user.displayName;
    $('#metricTarget').innerHTML = `${Number(user.targetScore).toLocaleString('vi-VN')}<small>/10</small>`;
    $('#practiceTarget').textContent = `${Number(user.targetScore).toLocaleString('vi-VN')}/10`;
    $('#targetProgress').style.width = `${Math.max(0, Math.min(100, Number(user.targetScore) * 10))}%`;
    $('#roadmapTarget').value = String(user.targetScore);
    $('#roadmapTargetValue').textContent = `${Number(user.targetScore).toLocaleString('vi-VN')}/10`;
    $('#profileAvatarLarge').textContent = initials(user.displayName);
  }

  function renderSkillList(skills) {
    const list = $('#skillList');
    const topSkills = [...(skills || [])].sort((a, b) => (b.attempts || 0) - (a.attempts || 0)).slice(0, 9);
    if (!topSkills.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-symbol">⌁</div><b>Hồ sơ đang chờ dữ liệu</b><p>Làm bài chẩn đoán đầu tiên để bắt đầu xây dựng bản đồ năng lực cá nhân.</p></div>';
      return;
    }
    list.innerHTML = topSkills.map(skill => {
      const accuracy = Math.max(0, Math.min(100, Number(skill.accuracy) || 0));
      const certainty = Number(skill.attempts) < 3 ? 'Dữ liệu còn ít' : Number(skill.attempts) < 7 ? 'Đang hình thành' : 'Có tín hiệu ổn định';
      return `<div class="skill-row"><div><div class="skill-name">${esc(skill.skill)}</div><span class="skill-topic">${esc(skill.topic || '')}</span></div><div><div class="skill-bar"><span style="width:${accuracy}%"></span></div><div class="skill-meta">${Number(skill.correct) || 0}/${Number(skill.attempts) || 0} câu đúng · ${certainty}</div></div><div class="skill-percent">${Math.round(accuracy)}%</div></div>`;
    }).join('');
  }

  function renderRecentSessions(sessions) {
    const el = $('#recentList');
    if (!sessions?.length) {
      el.innerHTML = '<p class="muted">Các buổi luyện tập sẽ xuất hiện ở đây. Bắt đầu một bài để tạo dữ liệu ban đầu.</p>';
      return;
    }
    el.innerHTML = sessions.slice(0, 5).map(s => `<div class="recent-item"><div class="recent-icon">${Number(s.score) >= Number(state.user?.targetScore || 7) ? '✦' : '⌁'}</div><div class="recent-copy"><b>Buổi luyện #${s.id}</b><small>${formatDate(s.date)} · ${s.answered}/${s.total} câu đã trả lời</small></div><div class="recent-score">${Number(s.score).toLocaleString('vi-VN')}/10</div></div>`).join('');
  }

  function formatDate(value) {
    if (!value) return 'Vừa xong';
    const date = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  }

  async function loadDashboard() {
    const data = await api('/api/dashboard');
    state.user = data.user;
    state.aiConfigured = Boolean(data.aiConfigured);
    updateUserChrome(data.user);
    const stats = data.stats || {};
    $('#metricLatest').innerHTML = `${stats.latestScore == null ? '—' : Number(stats.latestScore).toLocaleString('vi-VN')}<small>/10</small>`;
    $('#metricLatestNote').textContent = stats.latestScore == null ? 'Chưa có bài làm' : `Điểm trung bình ${stats.averageScore ?? '—'}/10`;
    $('#metricTarget').innerHTML = `${Number(data.user.targetScore).toLocaleString('vi-VN')}<small>/10</small>`;
    $('#targetProgress').style.width = `${Math.min(100, Number(data.user.targetScore) * 10)}%`;
    $('#targetNote').textContent = stats.bestScore == null ? 'Làm bài để theo dõi tiến bộ' : `Điểm cao nhất ${stats.bestScore}/10`;
    $('#metricAccuracy').innerHTML = `${stats.totalAnswered ? stats.accuracy : '—'}<small>%</small>`;
    $('#accuracyNote').textContent = `${stats.totalAnswered || 0} câu đã được ghi nhận`;
    $('#metricSessions').textContent = String(stats.quizzes || 0);
    renderSkillList(data.skills);
    renderRecentSessions(data.recentSessions);

    const weakest = [...(data.weakest || [])].sort((a, b) => a.accuracy - b.accuracy)[0];
    if (weakest) {
      $('#nextStepTitle').textContent = `Củng cố ${weakest.skill}`;
      $('#nextStepText').textContent = `Độ chính xác hiện tại ${Math.round(weakest.accuracy)}% qua ${weakest.attempts} lần làm. Hệ thống sẽ ưu tiên kỹ năng này nhưng vẫn kiểm tra kiến thức khác.`;
    } else {
      $('#nextStepTitle').textContent = stats.totalAnswered ? 'Mở rộng dữ liệu năng lực' : 'Bắt đầu bằng bài chẩn đoán';
      $('#nextStepText').textContent = stats.totalAnswered ? 'Cần thêm một vài lần luyện tập để tìm mẫu lỗi ổn định hơn.' : 'Làm đề đầu tiên để xây dựng hồ sơ năng lực cá nhân.';
    }
    if (data.plan?.text) $('#roadmapResult').innerHTML = markdown(data.plan.text);
    updateAiIndicator(data.aiConfigured);
  }

  function updateAiIndicator(ready) {
    const el = $('#aiIndicator');
    el.classList.toggle('offline', !ready);
    el.innerHTML = ready ? '<i></i> AI đã kết nối' : '<i></i> Chưa cấu hình AI';
    $('#tutorStatus').textContent = ready ? 'SẴN SÀNG' : 'CHƯA CẤU HÌNH';
    $('#tutorStatus').classList.toggle('pill-mint', ready);
    $('#tutorStatus').classList.toggle('pill-purple', !ready);
  }

  async function loadAiStatus() {
    try {
      const data = await api('/api/ai/status');
      state.aiConfigured = Boolean(data.configured);
      updateAiIndicator(state.aiConfigured);
    } catch { updateAiIndicator(false); }
  }

  async function startApp() {
    $('#authScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
    try {
      await loadDashboard();
      await loadAiStatus();
      await api('/api/ai/chat-history').then(renderChatHistory).catch(() => {});
    } catch (error) {
      if (error.status !== 401) toast(friendlyError(error), 'error');
    }
  }

  function showPage(page) {
    if (!PAGE_TITLES[page]) return;
    state.page = page;
    $$('.page-content').forEach(el => el.classList.add('hidden'));
    const target = $(`#${page}Page`);
    if (target) target.classList.remove('hidden');
    $$('.nav-item[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page && el.closest('.nav-list')));
    $('#pageTitle').textContent = PAGE_TITLES[page];
    $('#sidebar').classList.remove('open');
    if (page === 'dashboard') loadDashboard().catch(e => toast(friendlyError(e), 'error'));
    if (page === 'tutor') api('/api/ai/chat-history').then(renderChatHistory).catch(e => { if (e.status !== 401) toast(friendlyError(e), 'error'); });
    if (page === 'history') loadHistory().catch(e => toast(friendlyError(e), 'error'));
    if (page === 'leaderboard') loadLeaderboard().catch(e => toast(friendlyError(e), 'error'));
    if (page === 'profile') loadProfile().catch(e => toast(friendlyError(e), 'error'));
  }

  async function handleAuthForm(form, endpoint, buttonLabel) {
    const button = $('button[type="submit"]', form);
    setBusy(button, true, buttonLabel);
    try {
      const body = Object.fromEntries(new FormData(form).entries());
      const data = await api(endpoint, { method: 'POST', body });
      state.user = data.user;
      form.reset();
      await startApp();
      showPage('dashboard');
      toast(endpoint.endsWith('register') ? 'Tạo tài khoản thành công. Chúc bạn học tốt!' : 'Đăng nhập thành công. Chào mừng bạn trở lại!');
    } catch (error) {
      toast(friendlyError(error), 'error');
    } finally { setBusy(button, false); }
  }

  function switchPageFromEvent(event) {
    const nav = event.target.closest('[data-page]');
    if (nav) showPage(nav.dataset.page);
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function stopQuizTimer() {
    if (state.quizTimer) clearInterval(state.quizTimer);
    state.quizTimer = null;
  }

  function questionAnswered(question, value) {
    if (question.type === 'graph') return Array.isArray(value) && value.length > 0;
    if (question.type === 'match') return value && typeof value === 'object' && Object.keys(value).length === (question.pairs || []).length;
    return value !== undefined && value !== null && String(value).trim().length > 0;
  }

  function saveCurrentAnswer() {
    const quiz = state.quiz;
    if (!quiz?.questions?.length) return;
    const q = quiz.questions[quiz.index];
    if (!q) return;
    const area = $('#answerArea');
    if (q.type === 'mcq') {
      const chosen = $('.choice-option.selected', area);
      quiz.answers[q.id] = chosen ? chosen.dataset.value : (quiz.answers[q.id] ?? '');
    } else if (q.type === 'short') {
      quiz.answers[q.id] = $('.short-answer-input', area)?.value ?? quiz.answers[q.id] ?? '';
    } else if (q.type === 'match') {
      const values = {};
      $$('.match-row select', area).forEach(select => { if (select.value) values[select.dataset.pair] = select.value; });
      quiz.answers[q.id] = values;
    } else if (q.type === 'graph') {
      quiz.answers[q.id] = quiz.answers[q.id] || [];
    }
    const elapsed = quiz.questionStartedAt ? Math.floor((Date.now() - quiz.questionStartedAt) / 1000) : 0;
    quiz.times[q.id] = Math.min(3600, (quiz.times[q.id] || 0) + elapsed);
    quiz.questionStartedAt = null;
  }

  function saveAndMove(index) {
    if (!state.quiz) return;
    saveCurrentAnswer();
    state.quiz.index = Math.max(0, Math.min(index, state.quiz.questions.length - 1));
    renderQuestion();
  }

  async function beginQuiz() {
    const btn = $('#startQuizBtn');
    setBusy(btn, true, 'Đang chọn câu hỏi…');
    try {
      const data = await api('/api/quiz/start', { method: 'POST', body: {} });
      state.quiz = {
        questions: data.questions || [], index: 0, answers: {}, times: {}, startedAt: Date.now(),
        questionStartedAt: null, submitting: false
      };
      if (!state.quiz.questions.length) throw new Error('Chưa có câu hỏi trong ngân hàng đề.');
      $('#practiceIntro').classList.add('hidden');
      $('#quizResults').classList.add('hidden');
      $('#quizWorkspace').classList.remove('hidden');
      stopQuizTimer();
      state.quizTimer = setInterval(() => {
        if (state.quiz) $('#quizTimer').textContent = formatDuration((Date.now() - state.quiz.startedAt) / 1000);
      }, 1000);
      renderQuestion();
    } catch (error) { toast(friendlyError(error), 'error'); }
    finally { setBusy(btn, false); }
  }

  function renderQuestion() {
    const quiz = state.quiz;
    if (!quiz) return;
    const q = quiz.questions[quiz.index];
    if (!q) return;
    quiz.questionStartedAt = Date.now();
    $('#quizSection').textContent = q.sectionLabel || ({foundation:'Phần I · Nền tảng', application:'Phần II · Vận dụng', challenge:'Phần III · Thử thách'})[q.section] || q.section;
    $('#quizNumber').textContent = `Câu ${quiz.index + 1}/${quiz.questions.length}`;
    $('#quizProgressFill').style.width = `${((quiz.index + 1) / quiz.questions.length) * 100}%`;
    $('#questionTopic').textContent = String(q.topic || 'TOÁN HỌC').toUpperCase();
    $('#questionPoints').textContent = `${q.points} điểm`;
    $('#questionPrompt').textContent = q.prompt;
    const area = $('#answerArea');
    area.innerHTML = '';
    const answer = quiz.answers[q.id];

    if (q.type === 'mcq') {
      area.innerHTML = `<div class="choice-list">${(q.choices || []).map((choice, index) => `<button type="button" class="choice-option ${String(answer ?? '') === String(choice.value) ? 'selected' : ''}" data-value="${esc(choice.value)}"><span class="choice-letter">${String.fromCharCode(65 + index)}</span><span>${esc(choice.label)}</span></button>`).join('')}</div><p class="answer-hint">Chọn một đáp án. Bạn có thể quay lại sửa trước khi nộp bài.</p>`;
      $$('.choice-option', area).forEach(button => button.addEventListener('click', () => {
        $$('.choice-option', area).forEach(x => x.classList.remove('selected'));
        button.classList.add('selected');
        quiz.answers[q.id] = button.dataset.value;
        updateQuestionProgress();
      }));
    } else if (q.type === 'short') {
      area.innerHTML = `<div class="short-answer-wrap"><input class="short-answer-input" type="text" maxlength="180" autocomplete="off" aria-label="Câu trả lời" placeholder="Nhập đáp án của bạn" value="${esc(answer ?? '')}" /></div><p class="answer-hint">Nhập kết quả ngắn gọn. Dùng dấu phẩy nếu đề yêu cầu nhiều nghiệm.</p>`;
      $('.short-answer-input', area).addEventListener('input', event => {
        quiz.answers[q.id] = event.target.value;
        updateQuestionProgress();
      });
    } else if (q.type === 'match') {
      const values = answer && typeof answer === 'object' ? answer : {};
      area.innerHTML = `<div class="match-list">${(q.pairs || []).map((pair, index) => `<div class="match-row"><span>${esc(pair.prompt)}</span><select data-pair="${index}" aria-label="Chọn công thức"><option value="">Chọn đáp án…</option>${(pair.options || []).map(option => `<option value="${esc(option)}" ${String(values[index] || '') === String(option) ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select></div>`).join('')}</div><p class="answer-hint">Hoàn thành tất cả các dòng để được ghi nhận là đã trả lời.</p>`;
      $$('.match-row select', area).forEach(select => select.addEventListener('change', () => { saveCurrentAnswer(); quiz.questionStartedAt = Date.now(); updateQuestionProgress(); }));
    } else if (q.type === 'graph') {
      const points = Array.isArray(answer) ? answer : [];
      area.innerHTML = `<div class="graph-wrap"><p class="graph-instructions">Bấm lên hệ trục để đặt các điểm. Hệ thống dùng tọa độ gần nhất để đánh giá đồ thị.</p><canvas id="answerGraphCanvas" class="graph-canvas" width="600" height="400" aria-label="Hệ trục tọa độ tương tác"></canvas><div class="graph-controls"><span class="graph-point-count" id="graphPointCount">${points.length} điểm đã đặt</span><button class="btn btn-ghost" id="undoGraphPoint" type="button">Xóa điểm cuối</button></div></div><p class="answer-hint">Chọn ít nhất hai điểm phân biệt. Bản mẫu chấm theo các điểm đặt gần đường thẳng; chưa thay thế đánh giá hình vẽ tự luận.</p>`;
      drawGraph($('#answerGraphCanvas'), points);
      $('#answerGraphCanvas').addEventListener('click', event => {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const px = (event.clientX - rect.left) * canvas.width / rect.width;
        const py = (event.clientY - rect.top) * canvas.height / rect.height;
        const bounds = q.graphBounds || {minX:-5,maxX:5,minY:-5,maxY:5};
        const gx = bounds.minX + px / canvas.width * (bounds.maxX - bounds.minX);
        const gy = bounds.maxY - py / canvas.height * (bounds.maxY - bounds.minY);
        const point = { x: Math.round(gx), y: Math.round(gy) };
        const pts = [...(quiz.answers[q.id] || [])];
        if (pts.length < 20 && !pts.some(p => p.x === point.x && p.y === point.y)) pts.push(point);
        quiz.answers[q.id] = pts;
        drawGraph(canvas, pts);
        $('#graphPointCount').textContent = `${pts.length} điểm đã đặt`;
        updateQuestionProgress();
      });
      $('#undoGraphPoint').addEventListener('click', () => {
        const pts = [...(quiz.answers[q.id] || [])]; pts.pop(); quiz.answers[q.id] = pts;
        drawGraph($('#answerGraphCanvas'), pts); $('#graphPointCount').textContent = `${pts.length} điểm đã đặt`; updateQuestionProgress();
      });
    } else {
      area.innerHTML = '<p class="answer-hint">Dạng câu hỏi này chưa được hỗ trợ ở giao diện hiện tại.</p>';
    }
    $('#prevQuestionBtn').disabled = quiz.index === 0;
    $('#prevQuestionBtn').style.opacity = quiz.index === 0 ? '.4' : '1';
    $('#nextQuestionBtn').classList.toggle('hidden', quiz.index === quiz.questions.length - 1);
    $('#submitQuizBtn').classList.toggle('hidden', quiz.index !== quiz.questions.length - 1);
    renderNavigator();
    updateQuestionProgress();
  }

  function drawGraph(canvas, points) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const bounds = { minX: -5, maxX: 5, minY: -5, maxY: 5 };
    const X = x => (x - bounds.minX) / (bounds.maxX - bounds.minX) * w;
    const Y = y => (bounds.maxY - y) / (bounds.maxY - bounds.minY) * h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fcfcff'; ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1; ctx.strokeStyle = '#e8eaf4';
    for (let x = bounds.minX; x <= bounds.maxX; x++) { ctx.beginPath(); ctx.moveTo(X(x),0); ctx.lineTo(X(x),h); ctx.stroke(); }
    for (let y = bounds.minY; y <= bounds.maxY; y++) { ctx.beginPath(); ctx.moveTo(0,Y(y)); ctx.lineTo(w,Y(y)); ctx.stroke(); }
    ctx.strokeStyle = '#65708a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0,Y(0)); ctx.lineTo(w,Y(0)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X(0),0); ctx.lineTo(X(0),h); ctx.stroke();
    ctx.fillStyle = '#7d879d'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    for (let x = bounds.minX; x <= bounds.maxX; x++) if (x !== 0) ctx.fillText(String(x), X(x), Y(0) + 16);
    ctx.textAlign = 'left';
    for (let y = bounds.minY; y <= bounds.maxY; y++) if (y !== 0) ctx.fillText(String(y), X(0) + 6, Y(y) - 4);
    (points || []).forEach(point => {
      ctx.beginPath(); ctx.arc(X(point.x), Y(point.y), 6, 0, Math.PI * 2);
      ctx.fillStyle = '#7468ee'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    });
    if (points?.length >= 2) {
      ctx.setLineDash([6, 5]); ctx.strokeStyle = '#8478ef'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X(points[0].x),Y(points[0].y)); ctx.lineTo(X(points[points.length - 1].x),Y(points[points.length - 1].y)); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  function renderNavigator() {
    const quiz = state.quiz;
    const nav = $('#questionNavigator');
    if (!quiz) return;
    nav.innerHTML = quiz.questions.map((q, index) => `<button type="button" class="question-nav-btn ${index === quiz.index ? 'current' : ''} ${questionAnswered(q, quiz.answers[q.id]) ? 'answered' : ''}" data-index="${index}" aria-label="Câu ${index + 1}">${index + 1}</button>`).join('');
    $$('.question-nav-btn', nav).forEach(button => button.addEventListener('click', () => saveAndMove(Number(button.dataset.index))));
  }

  function updateQuestionProgress() {
    const quiz = state.quiz;
    if (!quiz) return;
    const answered = quiz.questions.filter(q => questionAnswered(q, quiz.answers[q.id])).length;
    $('#answeredCounter').textContent = `${answered}/${quiz.questions.length} câu đã trả lời`;
    $$('.question-nav-btn').forEach(button => {
      const question = quiz.questions[Number(button.dataset.index)];
      button?.classList.toggle('answered', questionAnswered(question, quiz.answers[question.id]));
    });
  }

  async function submitQuiz() {
    const quiz = state.quiz;
    if (!quiz || quiz.submitting) return;
    saveCurrentAnswer();
    const answered = quiz.questions.filter(q => questionAnswered(q, quiz.answers[q.id])).length;
    if (answered < quiz.questions.length && !window.confirm(`Bạn mới trả lời ${answered}/${quiz.questions.length} câu. Vẫn nộp bài?`)) {
      renderQuestion(); return;
    }
    quiz.submitting = true;
    setBusy($('#submitQuizBtn'), true, 'Đang chấm bài…');
    setBusy($('#endQuizEarlyBtn'), true, 'Đang chấm…');
    try {
      const answers = {};
      quiz.questions.forEach(q => {
        if (q.type === 'graph') answers[q.id] = Array.isArray(quiz.answers[q.id]) ? quiz.answers[q.id] : [];
        else if (q.type === 'match') answers[q.id] = quiz.answers[q.id] || {};
        else answers[q.id] = quiz.answers[q.id] ?? '';
      });
      const data = await api('/api/quiz/submit', { method: 'POST', body: { answers, times: quiz.times } });
      stopQuizTimer();
      state.lastResults = data;
      renderQuizResults(data);
      $('#quizWorkspace').classList.add('hidden');
      $('#quizResults').classList.remove('hidden');
      await loadDashboard();
      toast('Bài làm đã được chấm và lưu vào hồ sơ riêng của bạn.');
    } catch (error) { toast(friendlyError(error), 'error'); quiz.submitting = false; }
    finally { setBusy($('#submitQuizBtn'), false); setBusy($('#endQuizEarlyBtn'), false); }
  }

  function presentAnswer(value) {
    if (value === null || value === undefined || value === '') return 'Chưa trả lời';
    if (Array.isArray(value)) return value.map(p => `(${p.x}; ${p.y})`).join(', ') || 'Chưa đặt điểm';
    if (typeof value === 'object') return Object.entries(value).map(([key, val]) => `${Number(key) + 1}: ${val}`).join(' · ') || 'Chưa trả lời';
    return String(value);
  }

  function renderQuizResults(data) {
    $('#resultMessage').textContent = data.message || 'Kết quả đã được lưu vào hồ sơ của bạn.';
    $('#resultScore').innerHTML = `${Number(data.score10).toLocaleString('vi-VN')}<span>/10</span>`;
    const correct = (data.results || []).filter(r => r.correct).length;
    $('#resultCorrect').textContent = `${correct}/${data.totalCount}`;
    $('#resultAccuracy').textContent = `${data.totalCount ? Math.round(correct / data.totalCount * 100) : 0}%`;
    $('#resultTarget').textContent = `${Number(state.user?.targetScore ?? 7).toLocaleString('vi-VN')}/10`;
    $('#resultItems').innerHTML = (data.results || []).map((r, index) => {
      const correctAnswer = presentAnswer(r.correctAnswer);
      const userAnswer = presentAnswer(r.userAnswer);
      return `<article class="result-item"><div class="result-item-top"><b>Câu ${index + 1} · ${esc(r.skill || r.topic)} <span class="small-muted">· ${r.pointsEarned}/${r.pointsPossible} điểm</span></b><span class="result-state ${r.correct ? 'good' : 'bad'}">${r.correct ? 'CHÍNH XÁC' : 'CẦN SỬA'}</span></div><p><strong>Đề:</strong> ${esc(r.prompt)}</p><p><strong>Bạn trả lời:</strong> ${esc(userAnswer)}</p>${r.correct ? '' : `<p><strong>Đáp án tham khảo:</strong> ${esc(correctAnswer)}</p>`}<p><strong>Giải thích:</strong> ${esc(r.explanation)}</p>${r.correct ? '' : `<p><strong>Mẫu lỗi cần kiểm tra:</strong> ${esc(r.errorType || 'Sai phương pháp hoặc tính toán')}</p>`}</article>`;
    }).join('');
  }

  function renderChatWelcome() {
    $('#chatLog').innerHTML = `<div class="chat-welcome"><div class="chat-welcome-symbol">ƒ</div><h3>Ta cùng gỡ từng nút thắt nhé.</h3><p>MathMate dùng tiến trình riêng của bạn để giải thích bài Toán, phân tích lỗi và tạo bài luyện phù hợp.</p><div class="suggestion-chips"><button type="button" data-prompt="Giúp mình tìm ra kỹ năng Toán đang yếu nhất từ dữ liệu hiện có.">Phân tích kỹ năng yếu</button><button type="button" data-prompt="Hãy giải thích phương trình bậc hai bằng một ví dụ dễ hiểu.">Giải thích kiến thức</button><button type="button" data-prompt="Tạo một bài Toán lớp 9 có gợi ý từng bước, đừng đưa đáp án ngay.">Luyện bài mới</button></div></div>`;
  }

  function appendChat(role, content, { pending = false } = {}) {
    const log = $('#chatLog');
    const welcome = $('.chat-welcome', log);
    if (welcome) welcome.remove();
    const row = document.createElement('div');
    row.className = `chat-message ${role === 'user' ? 'user' : 'assistant'}`;
    const avatar = document.createElement('div'); avatar.className = 'chat-mini-avatar'; avatar.textContent = role === 'user' ? initials(state.user?.displayName) : 'M+';
    const bubble = document.createElement('div'); bubble.className = `chat-bubble${pending ? ' pending' : ''}`;
    if (pending) bubble.textContent = content; else bubble.innerHTML = markdown(content);
    row.append(avatar, bubble); log.appendChild(row); log.scrollTop = log.scrollHeight;
    return row;
  }

  function renderChatHistory(data) {
    const log = $('#chatLog');
    log.innerHTML = '';
    const messages = data?.messages || [];
    if (!messages.length) { renderChatWelcome(); return; }
    messages.forEach(message => appendChat(message.role, message.content));
    log.scrollTop = log.scrollHeight;
  }

  async function sendTutorMessage(raw) {
    const message = String(raw || '').trim();
    if (!message || message.length > 5000 || state.isBusy) return;
    state.isBusy = true;
    $('#chatInput').value = '';
    $('#chatCharCount').textContent = '0/5000';
    appendChat('user', message);
    const pending = appendChat('assistant', 'Đang xem xét câu hỏi và hồ sơ học tập của bạn…', { pending: true });
    const sendButton = $('#chatForm button[type="submit"]'); setBusy(sendButton, true, '');
    try {
      const data = await api('/api/ai/tutor', { method: 'POST', body: { message } });
      pending.remove(); appendChat('assistant', data.reply || 'Mình chưa có phản hồi trong lượt này.');
    } catch (error) {
      pending.remove(); appendChat('assistant', friendlyError(error));
    } finally { state.isBusy = false; setBusy(sendButton, false); }
  }

  async function loadHistory() {
    const data = await api('/api/history');
    const sessions = $('#historySessions');
    sessions.innerHTML = data.sessions.length ? data.sessions.map(s => `<div class="history-session"><div class="history-session-score">${Number(s.score).toLocaleString('vi-VN')}</div><div class="history-session-copy"><b>Buổi luyện #${s.id}</b><small>${formatDate(s.date)} · ${s.answered}/${s.total} câu đã trả lời</small></div><div class="history-session-trend">${Number(s.score) >= Number(state.user?.targetScore || 7) ? 'Đạt mục tiêu' : `Mục tiêu ${Number(state.user?.targetScore || 7)}/10`}</div></div>`).join('') : '<div class="empty-state"><div class="empty-symbol">◷</div><b>Chưa có buổi luyện nào</b><p>Làm một đề thích ứng để hệ thống ghi nhận tiến trình học.</p></div>';
    const attempts = $('#historyAttempts');
    attempts.innerHTML = data.attempts.length ? data.attempts.map(a => `<div class="history-attempt ${a.is_correct ? 'correct' : ''}"><span class="history-attempt-dot"></span><div><b>${esc(a.skill)} <span class="small-muted">· ${esc(a.topic)}</span></b><small>${formatDate(a.created_at)} · ${Number(a.seconds) || 0} giây ${a.error_type ? `· Mẫu lỗi: ${esc(a.error_type)}` : ''}</small></div><span class="history-attempt-tag">${a.is_correct ? 'Đúng' : 'Cần xem lại'}</span></div>`).join('') : '<p class="muted">Chưa có dữ liệu lỗi sai. Sau bài luyện đầu tiên, phần này sẽ giúp bạn nhận ra những lỗi lặp lại.</p>';
  }

  async function loadLeaderboard() {
    const data = await api('/api/leaderboard');
    const el = $('#leaderboardList');
    if (!data.entries?.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-symbol">♜</div><b>Bảng thi đua đang chờ thành viên</b><p>Bạn có thể bật chia sẻ tự nguyện trong Hồ sơ & cài đặt sau khi làm bài.</p></div>';
      return;
    }
    el.className = 'leaderboard-list';
    el.innerHTML = data.entries.map(row => `<div class="leaderboard-row"><div class="leaderboard-rank">${row.rank}</div><div class="leaderboard-person"><b>${esc(row.name)} ${row.rank === 1 ? '✦' : ''}</b><small>${esc(row.school)}${row.city ? ` · ${esc(row.city)}` : ''} · ${row.quizzes} buổi</small></div><div class="leaderboard-score"><b>${Number(row.averageScore).toLocaleString('vi-VN')}</b><small>Trung bình</small></div><div class="leaderboard-score"><b>${Number(row.bestScore).toLocaleString('vi-VN')}</b><small>Cao nhất</small></div></div>`).join('');
  }

  async function loadProfile() {
    const data = await api('/api/profile');
    state.user = data.user;
    updateUserChrome(data.user);
    const form = $('#profileForm');
    form.elements.displayName.value = data.user.displayName || '';
    form.elements.email.value = data.user.email || '';
    form.elements.grade.value = String(data.user.grade || 9);
    form.elements.targetScore.value = String(data.user.targetScore || 7);
    form.elements.school.value = data.user.school || '';
    form.elements.city.value = data.user.city || '';
    form.elements.leaderboardOptIn.checked = Boolean(data.user.leaderboardOptIn);
  }

  async function makeStudyPlan(event) {
    event.preventDefault();
    const button = $('button[type="submit"]', $('#roadmapForm'));
    setBusy(button, true, 'Đang thiết kế lộ trình…');
    $('#roadmapResult').innerHTML = '<div class="loading-state"><span class="spinner"></span> Đang kết hợp dữ liệu học tập và mục tiêu của bạn…</div>';
    try {
      const data = await api('/api/ai/plan', { method: 'POST', body: { targetScore: Number($('#roadmapTarget').value), weeks: Number($('#roadmapWeeks').value) } });
      $('#roadmapResult').innerHTML = markdown(data.plan || 'Chưa tạo được lộ trình.');
      toast('Lộ trình đã được lưu vào hồ sơ của bạn.');
    } catch (error) { $('#roadmapResult').innerHTML = `<p>${esc(friendlyError(error))}</p>`; toast(friendlyError(error), 'error'); }
    finally { setBusy(button, false); }
  }

  async function diagnoseProfile() {
    setBusy($('#diagnoseBtn'), true, 'Đang phân tích…');
    const box = $('#diagnosisBox'); box.classList.remove('hidden'); box.innerHTML = 'AI đang đọc các mẫu làm bài đã ghi nhận…';
    try { const data = await api('/api/ai/diagnose', { method: 'POST', body: {} }); box.innerHTML = markdown(data.report || 'Chưa có báo cáo.'); }
    catch (error) { box.innerHTML = esc(friendlyError(error)); toast(friendlyError(error), 'error'); }
    finally { setBusy($('#diagnoseBtn'), false); }
  }

  async function generateErrorHunt() {
    setBusy($('#generateErrorBtn'), true, 'Đang tạo thử thách…');
    const result = $('#errorHuntResult'); result.classList.remove('hidden'); result.textContent = 'AI đang tạo một lời giải sai có chủ đích dựa trên kỹ năng cần củng cố…';
    try { const data = await api('/api/ai/error-hunt', { method: 'POST', body: {} }); result.innerHTML = markdown(data.activity || 'Chưa tạo được bài.'); }
    catch (error) { result.textContent = friendlyError(error); toast(friendlyError(error), 'error'); }
    finally { setBusy($('#generateErrorBtn'), false); }
  }

  async function analyzeSolutionImage() {
    const file = $('#solutionImage').files?.[0];
    if (!file) { toast('Hãy chọn ảnh lời giải trước.', 'error'); return; }
    if (!['image/png','image/jpeg','image/webp'].includes(file.type)) { toast('Chỉ hỗ trợ ảnh PNG, JPG hoặc WEBP.', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('Ảnh tối đa 5 MB. Hãy chọn ảnh nhỏ hơn.', 'error'); return; }
    const button = $('#analyzeImageBtn'); setBusy(button, true, 'Đang đọc ảnh…');
    const output = $('#imageAnalysisResult'); output.classList.remove('hidden'); output.textContent = 'Đang đọc lời giải. Ảnh sẽ được gửi tới nhà cung cấp AI đã cấu hình để xử lý và không được lưu thành tệp trong cơ sở dữ liệu MathMate.';
    try {
      const imageData = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Không thể đọc tệp ảnh.')); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); });
      const data = await api('/api/ai/analyze-image', { method: 'POST', body: { imageData, questionText: $('#imageContext').value.trim() || 'Hãy phân tích lời giải Toán trong ảnh.' } });
      output.innerHTML = markdown(data.analysis || 'Chưa phân tích được ảnh.');
    } catch (error) { output.textContent = friendlyError(error); toast(friendlyError(error), 'error'); }
    finally { setBusy(button, false); }
  }

  function openModal({ title, text, needsPassword = false, confirmLabel = 'Xác nhận', danger = true, action }) {
    state.modalAction = action;
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalInputWrap').classList.toggle('hidden', !needsPassword);
    $('#modalPassword').value = '';
    $('#modalConfirmBtn').textContent = confirmLabel;
    $('#modalConfirmBtn').classList.toggle('btn-danger', danger);
    $('#modalConfirmBtn').classList.toggle('btn-primary', !danger);
    $('#confirmModal').classList.remove('hidden');
  }

  function closeModal() {
    $('#confirmModal').classList.add('hidden'); state.modalAction = null; $('#modalPassword').value = '';
  }

  async function confirmModalAction() {
    if (!state.modalAction) return closeModal();
    const button = $('#modalConfirmBtn'); setBusy(button, true, 'Đang xử lý…');
    try { await state.modalAction(); closeModal(); }
    catch (error) { toast(friendlyError(error), 'error'); }
    finally { setBusy(button, false); }
  }

  function setupEvents() {
    $('#loginTab').addEventListener('click', () => switchAuth('login'));
    $('#registerTab').addEventListener('click', () => switchAuth('register'));
    $('#loginForm').addEventListener('submit', event => { event.preventDefault(); handleAuthForm(event.currentTarget, '/api/auth/login', 'Đang đăng nhập…'); });
    $('#registerForm').addEventListener('submit', event => { event.preventDefault(); handleAuthForm(event.currentTarget, '/api/auth/register', 'Đang tạo tài khoản…'); });
    document.addEventListener('click', switchPageFromEvent);
    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
      showAuth('login'); toast('Bạn đã đăng xuất.');
    });
    $('#mobileMenuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    $('#dashboardStartBtn').addEventListener('click', () => showPage('practice'));
    $('#nextStepBtn').addEventListener('click', () => showPage('practice'));
    $('#startQuizBtn').addEventListener('click', beginQuiz);
    $('#prevQuestionBtn').addEventListener('click', () => { if (state.quiz && state.quiz.index > 0) saveAndMove(state.quiz.index - 1); });
    $('#nextQuestionBtn').addEventListener('click', () => { if (state.quiz && state.quiz.index < state.quiz.questions.length - 1) saveAndMove(state.quiz.index + 1); });
    $('#submitQuizBtn').addEventListener('click', submitQuiz);
    $('#endQuizEarlyBtn').addEventListener('click', submitQuiz);
    $('#resultNewQuizBtn').addEventListener('click', () => { $('#quizResults').classList.add('hidden'); $('#practiceIntro').classList.remove('hidden'); beginQuiz(); });
    $('#resultTutorBtn').addEventListener('click', () => { showPage('tutor'); const result = state.lastResults; if (result) $('#chatInput').value = `Giúp mình phân tích những lỗi sai trong bài gần nhất (điểm ${result.score10}/10). Hãy giải thích từng lỗi và cho một bài tương tự để kiểm tra lại.`; $('#chatInput').focus(); $('#chatCharCount').textContent = `${$('#chatInput').value.length}/5000`; });
    $('#resultDashboardBtn').addEventListener('click', () => showPage('dashboard'));
    $('#diagnoseBtn').addEventListener('click', diagnoseProfile);
    $('#roadmapTarget').addEventListener('input', () => { $('#roadmapTargetValue').textContent = `${Number($('#roadmapTarget').value).toLocaleString('vi-VN')}/10`; });
    $('#roadmapForm').addEventListener('submit', makeStudyPlan);
    $('#chatForm').addEventListener('submit', event => { event.preventDefault(); sendTutorMessage($('#chatInput').value); });
    $('#chatInput').addEventListener('input', () => { $('#chatCharCount').textContent = `${$('#chatInput').value.length}/5000`; });
    $('#chatInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#chatForm').requestSubmit(); } });
    document.addEventListener('click', event => { const chip = event.target.closest('[data-prompt]'); if (chip && chip.closest('#chatLog')) { $('#chatInput').value = chip.dataset.prompt; $('#chatCharCount').textContent = `${$('#chatInput').value.length}/5000`; $('#chatInput').focus(); } });
    $('#solutionImage').addEventListener('change', () => { const file = $('#solutionImage').files?.[0]; if (file) $('.upload-drop b').textContent = file.name; });
    $('#analyzeImageBtn').addEventListener('click', analyzeSolutionImage);
    $('#generateErrorBtn').addEventListener('click', generateErrorHunt);
    $('#clearChatBtn').addEventListener('click', () => openModal({ title:'Xóa lịch sử AI?', text:'Toàn bộ tin nhắn gia sư AI trong tài khoản này sẽ bị xóa. Không thể hoàn tác.', confirmLabel:'Xóa lịch sử', action:async()=>{ await api('/api/ai/chat-history',{method:'DELETE'}); renderChatWelcome(); toast('Đã xóa lịch sử trò chuyện.'); } }));
    $('#historyStartBtn').addEventListener('click', () => showPage('practice'));
    $('#profileForm').addEventListener('submit', async event => {
      event.preventDefault(); const button = $('button[type="submit"]', event.currentTarget); setBusy(button,true,'Đang lưu…');
      try {
        const form = event.currentTarget;
        const body = { displayName:form.elements.displayName.value, grade:Number(form.elements.grade.value), targetScore:Number(form.elements.targetScore.value), school:form.elements.school.value, city:form.elements.city.value, leaderboardOptIn:form.elements.leaderboardOptIn.checked };
        const data = await api('/api/profile',{method:'PATCH',body}); state.user=data.user; updateUserChrome(data.user); toast('Hồ sơ đã được cập nhật.');
      } catch (error) { toast(friendlyError(error),'error'); }
      finally { setBusy(button,false); }
    });
    $('#deleteAccountBtn').addEventListener('click', () => openModal({title:'Xóa tài khoản của bạn?',text:'Thao tác này sẽ xóa tài khoản, điểm số, hồ sơ năng lực và lịch sử gia sư AI. Nhập mật khẩu để xác nhận.',needsPassword:true,confirmLabel:'Xóa vĩnh viễn',action:async()=>{const password=$('#modalPassword').value;if(!password)throw new Error('Hãy nhập mật khẩu để xác nhận.');await api('/api/auth/account',{method:'DELETE',body:{password}});showAuth('login');toast('Tài khoản đã được xóa.');}}));
    $('#closeModalBtn').addEventListener('click', closeModal);
    $('#modalCancelBtn').addEventListener('click', closeModal);
    $('#modalConfirmBtn').addEventListener('click', confirmModalAction);
    $('#confirmModal').addEventListener('click', event => { if (event.target === $('#confirmModal')) closeModal(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); $('#sidebar').classList.remove('open'); } });
  }

  async function initialize() {
    setupEvents();
    try {
      const data = await api('/api/auth/me');
      state.user = data.user;
      await startApp();
    } catch {
      showAuth('login');
      updateAiIndicator(false);
    }
  }

  document.addEventListener('DOMContentLoaded', initialize);
})();
