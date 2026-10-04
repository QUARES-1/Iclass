import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime,
  parseTime,
  buildSchedule,
  scheduleTotalMinutes,
  generateSampleHeadUpRate,
  generateSampleHeadUpRateForSchedule,
  analyzeHeadUpRate,
  parseTranscript,
  analyzeSpeechRate,
  analyzeTone,
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

test('生成示例抬头率并分析', () => {
  const samples = generateSampleHeadUpRate(45, 60);
  assert.ok(samples.length >= 40);
  const a = analyzeHeadUpRate(samples, 0.6);
  assert.ok(a.average > 0 && a.average <= 1);
  assert.ok(a.min <= a.average && a.average <= a.max);
});

test('课时结构采样包含课间休息段', () => {
  const s = buildSchedule(45, 10, 45);
  const samples = generateSampleHeadUpRateForSchedule(s, 60);
  const a = analyzeHeadUpRate(samples, 0.6);
  assert.ok(a.breakSegments.length >= 1);
  assert.ok(a.breakSegments[0].start >= 45 * 60 - 60);
  assert.ok(a.breakSegments[0].end <= 55 * 60 + 60);
  assert.ok(a.average > 0.6);
});

test('能定位连续低于阈值的回落时间段', () => {
  const samples = [
    { t: 0, rate: 0.9 },
    { t: 60, rate: 0.5 },
    { t: 120, rate: 0.4 },
    { t: 180, rate: 0.8 },
    { t: 240, rate: 0.55 },
    { t: 300, rate: 0.5 },
  ];
  const a = analyzeHeadUpRate(samples, 0.6);
  assert.equal(a.lowSegments.length, 2);
  assert.deepEqual(a.lowSegments[0], { start: 60, end: 120 });
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
  assert.equal(tone.questions, 1);
});

test('生成课堂时间轴并包含三类事件', () => {
  const samples = generateSampleHeadUpRate(45, 120);
  const a = analyzeHeadUpRate(samples, 0.6);
  const segs = parseTranscript('[00:00-01:00] 大家好\n[05:00-06:00] 看快速排序');
  const events = buildTimeline(a, segs);
  assert.ok(events.some((e) => e.type === 'speech'));
  assert.ok(events.some((e) => e.type === 'attention-low'));
  assert.ok(events.length >= 2);
});

test('课时结构时间轴包含课间休息事件', () => {
  const s = buildSchedule(45, 10, 45);
  const samples = generateSampleHeadUpRateForSchedule(s, 120);
  const a = analyzeHeadUpRate(samples, 0.6);
  const segs = parseTranscript('[00:00-01:00] 大家好');
  const events = buildTimeline(a, segs);
  assert.ok(events.some((e) => e.type === 'break'));
});

test('生成带时间戳的课堂记录 Markdown', () => {
  const samples = generateSampleHeadUpRate(45, 120);
  const a = analyzeHeadUpRate(samples, 0.6);
  const segs = parseTranscript('[00:00-01:00] 大家好');
  const rate = analyzeSpeechRate(segs, 45);
  const tone = analyzeTone(segs);
  const events = buildTimeline(a, segs);
  const md = buildClassroomRecord({
    meta: { course: '数据结构', durationMin: 45, startTime: '08:00', schedule: buildSchedule(45, 10, 45) },
    headUpRate: a,
    speech: rate,
    tone,
    events,
  });
  assert.ok(md.includes('# 课堂记录'));
  assert.ok(md.includes('数据结构'));
  assert.ok(md.includes('抬头率统计'));
  assert.ok(md.includes('时间轴'));
});