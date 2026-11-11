import test from "node:test";
import assert from "node:assert/strict";
import { VoiceCapture, SPEECH_SILENCE_GRACE_MS, type SpeechSegment } from "../desktop/voice-capture.js";

function capture() {
  const segments: SpeechSegment[] = [], starts: { startedAt: number }[] = [], discarded: number[] = [];
  let time = 0;
  const voice = new VoiceCapture({
    now: () => time, onLevel() {},
    onSpeechStart: (event) => starts.push(event),
    onSpeechEnd: (event) => segments.push(event),
    onDiscard: (duration) => discarded.push(duration)
  });
  voice.context = { sampleRate: 48000, async close() {} } as AudioContext;
  voice.muted = false;
  function feed(ms: number, amplitude = 0) {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
      time += 20;
      voice.process(new Float32Array(960).fill(amplitude));
    }
  }
  return { voice, segments, starts, discarded, feed };
}

test("thinking pauses stay in one note until two seconds of silence", () => {
  const { feed, segments, starts } = capture();
  assert.equal(SPEECH_SILENCE_GRACE_MS, 2000);
  feed(1200, .1);
  feed(1500);
  assert.equal(segments.length, 0);
  feed(1200, .1);
  feed(1980);
  assert.equal(segments.length, 0);
  feed(20);
  assert.equal(segments.length, 1);
  assert.equal(starts.length, 1);
  // Keep the thinking pause but trim the final two-second silence.
  assert.equal(segments[0].durationMs, 4060);
  feed(1200, .1);
  feed(2000);
  assert.equal(segments.length, 2);
});

test("long silence does not inflate a short sound into a note", () => {
  const { feed, segments, discarded } = capture();
  feed(200, .1);
  feed(2000);
  assert.equal(segments.length, 0);
  assert.deepEqual(discarded, [360]);
});

test("mute and stop flush immediately without duplicating the first frame", async () => {
  const { voice, feed, segments } = capture();
  feed(1200, .1);
  voice.setMuted(true);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].durationMs, 1200);
  feed(2000); // Disabled microphone tracks deliver silence.
  assert.equal(segments.length, 1);
  voice.setMuted(false);
  feed(1200, .1);
  await voice.stop();
  assert.equal(segments.length, 2);
});

test("holding to talk records while muted and sends on release, without waiting for silence", () => {
  const { voice, feed, segments, starts } = capture();
  voice.setMuted(true);
  feed(1500, .1); // Muted: nothing is captured.
  assert.equal(starts.length, 0);
  voice.hold();
  assert.equal(starts.length, 1);
  feed(300, .1);
  feed(2500); // A long thinking pause must not end a held segment.
  feed(300, .1);
  assert.equal(segments.length, 0);
  voice.release();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].durationMs, 3100);
  feed(1500, .1); // Released: muted again.
  assert.equal(starts.length, 1);
});

test("a brief hold still sends, a tap or a cancelled recording does not", () => {
  const { voice, feed, segments, discarded } = capture();
  voice.setMuted(true);
  voice.hold(); feed(500, .1); voice.release();
  assert.equal(segments.length, 1);
  voice.hold(); feed(100, .1); voice.release();
  assert.equal(segments.length, 1);
  assert.deepEqual(discarded, [100]);
  voice.hold(); feed(3000, .1); voice.cancel();
  assert.equal(segments.length, 1);
  assert.deepEqual(discarded, [100, 0]);
  voice.setMuted(false);
  feed(1500, .1); voice.cancel(); feed(2500);
  assert.equal(segments.length, 1, "Esc also discards an open-mic segment");
});

test("holding on an open mic sends the current segment immediately on release", () => {
  const { voice, feed, segments } = capture();
  feed(1200, .1);
  voice.hold();
  feed(400, .1);
  voice.release();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].durationMs, 1600);
});
