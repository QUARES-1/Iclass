import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime,
  parseTime,
  buildSchedule,
  scheduleTotalMinutes,
  parseTranscript,
  analyzeSpeechRate,
  analyzeTone,
  analyzeKeywords,
  analyzeInteraction,
  buildTimeline,
  buildClassroomRecord,
} from '../src/classroom.js';

test('formatTime 与 parseTime 互逆', () => {
  assert.equal(formatTime(65), '01:05');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(parseTime('01:05'), 65);
  assert.equal(parseTime('1:01:01'), 3661);
  assert.equal(parseTime('00:55'), 55);
});

test('构建两节课加课间休息的课时结构', () => {
  const s = buildSchedule(45, 10, 45);
  assert.equal(s.length, 3);
  assert.equal(s[0].type, 'class');
  assert.equal(s[1].type, 'break');
  assert.equal(s[2].type, 'class');
  assert.equal(scheduleTotalMinutes(s), 100);
});

test('解析带时间戳的转写', () => {
  const segs = parseTranscript('[00:00-00:55] 大家好\n01:00-02:00 今天我们讲排序');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, 55);
  assert.equal(segs[0].text, '大家好');
  assert.equal(segs[1].end, 120);
});

test('分析语速与语调', () => {
  const segs = parseTranscript('[00:00-01:00] 今天我们来学习快速排序。\n[01:00-02:00] 大家有什么问题吗？');
  const rate = analyzeSpeechRate(segs, 1);
  assert.ok(rate.charsPerMin > 0);
  assert.equal(rate.segmentCount, 2);
  const tone = analyzeTone(segs);
  assert.ok(tone.sentences >= 2);
  assert.ok(tone.avgSentenceLen > 0);
});

test('提取关键词', () => {
  const segs = parseTranscript('[00:00-01:00] 快速排序的核心是分治\n[01:00-02:00] 快速排序平均复杂度是 n log n\n[02:00-03:00] 冒泡排序的复杂度是 n 的平方');
  const keywords = analyzeKeywords(segs, 10);
  assert.ok(keywords.length > 0);
  assert.ok(keywords.some((k) => k.word.includes('排序')));
  assert.ok(keywords.every((k) => k.count >= 2));
});

test('分析提问与互动', () => {
  const segs = parseTranscript('[00:00-01:00] 大家思考一下这个问题？\n[01:00-02:00] 谁来回答一下。');
  const interaction = analyzeInteraction(segs);
  assert.equal(interaction.questions, 1);
  assert.ok(interaction.interactionCount > 0);
  assert.equal(interaction.questionSegments.length, 1);
});

test('生成课堂时间轴并包含讲解/提问/课间休息', () => {
  const s = buildSchedule(45, 10, 45);
  const segs = parseTranscript('[00:00-01:00] 大家好\n[05:00-06:00] 大家有什么问题吗？');
  const events = buildTimeline(s, segs);
  assert.ok(events.some((e) => e.type === 'speech'));
  assert.ok(events.some((e) => e.type === 'question'));
  assert.ok(events.some((e) => e.type === 'break'));
});

test('生成课堂分析报告 Markdown', () => {
  const segs = parseTranscript('[00:00-01:00] 快速排序是重点');
  const rate = analyzeSpeechRate(segs, 45);
  const tone = analyzeTone(segs);
  const keywords = analyzeKeywords(segs, 10);
  const interaction = analyzeInteraction(segs);
  const events = buildTimeline(buildSchedule(45, 10, 45), segs);
  const md = buildClassroomRecord({
    meta: { course: '数据结构', durationMin: 100, startTime: '08:00', schedule: buildSchedule(45, 10, 45) },
    speech: rate,
    tone,
    keywords,
    interaction,
    events,
  });
  assert.ok(md.includes('# 课堂分析报告'));
  assert.ok(md.includes('数据结构'));
  assert.ok(md.includes('语速分析'));
  assert.ok(md.includes('关键词'));
  assert.ok(md.includes('时间轴'));
  assert.ok(!md.includes('抬头率'));
});