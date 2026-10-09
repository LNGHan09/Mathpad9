const test = require('node:test');
const assert = require('node:assert/strict');
const { questions, publicQuestion, SECTION_LABELS } = require('../questions');

test('ngân hàng câu hỏi có ít nhất 45 câu và không trùng ID', () => {
  assert.ok(questions.length >= 45, `Chỉ có ${questions.length} câu hỏi`);
  const ids = questions.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length, 'ID câu hỏi phải duy nhất');
});

test('mỗi câu thuộc một phần hợp lệ, có đáp án/lời giải và kỹ năng', () => {
  for (const q of questions) {
    assert.ok(SECTION_LABELS[q.section], `${q.id}: phần đề không hợp lệ`);
    assert.ok(q.skill && q.topic && q.prompt && q.explanation && q.errorType, `${q.id}: thiếu metadata`);
    assert.ok(['mcq', 'short', 'match', 'graph'].includes(q.type), `${q.id}: dạng câu hỏi không hợp lệ`);
    assert.ok(q.answer !== undefined, `${q.id}: thiếu đáp án ở máy chủ`);
    if (q.type === 'mcq') {
      assert.ok(q.choices?.length >= 2, `${q.id}: thiếu lựa chọn`);
      assert.ok(q.choices.some(c => String(c.value) === String(q.answer)), `${q.id}: đáp án không khớp lựa chọn`);
    }
  }
});

test('API câu hỏi công khai không làm lộ đáp án hoặc hàm chấm điểm', () => {
  for (const q of questions) {
    const pub = publicQuestion(q);
    assert.equal('answer' in pub, false, `${q.id}: đáp án bị lộ`);
    assert.equal('accepted' in pub, false, `${q.id}: biến thể đáp án bị lộ`);
    assert.equal('graphFunction' in pub, false, `${q.id}: hàm chấm đồ thị bị lộ`);
    if (pub.pairs) for (const pair of pub.pairs) assert.equal('key' in pair, false, `${q.id}: khóa ghép cặp bị lộ`);
  }
});

test('đề có đủ ba phần và có kỹ năng Toán đa dạng', () => {
  const sections = new Set(questions.map(q => q.section));
  assert.deepEqual(sections, new Set(['foundation', 'application', 'challenge']));
  assert.ok(new Set(questions.map(q => q.skill)).size >= 20);
});
