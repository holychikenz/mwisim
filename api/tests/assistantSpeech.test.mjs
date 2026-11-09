// Roboburble's speech engine pick and error text, over fake browser globals.
import test from 'node:test';
import assert from 'node:assert/strict';

const { pickSpeechEngine, speechErrorMessage } = await import('../../ui/src/assistant/speech.js');

const F = function () {};
const whisperBits = { MediaRecorder: F, navigator: { mediaDevices: { getUserMedia: F } }, AudioContext: F, Worker: F, WebAssembly: {} };
const chrome = { isSecureContext: true, webkitSpeechRecognition: F, SpeechRecognition: F, ...whisperBits };

test('1: Chrome-like — Web Speech by default, Whisper when preferred', () => {
  assert.equal(pickSpeechEngine('webspeech', chrome).engine, 'webspeech');
  const w = pickSpeechEngine('whisper', chrome);
  assert.equal(w.engine, 'whisper');
  assert.equal(w.fallback, false);
});

test('2: Safari-like (prefixed only) — Web Speech', () => {
  assert.equal(pickSpeechEngine('webspeech', { isSecureContext: true, webkitSpeechRecognition: F, ...whisperBits }).engine, 'webspeech');
});

test('3: Firefox-like (no SpeechRecognition) — falls back to Whisper', () => {
  const r = pickSpeechEngine('webspeech', { isSecureContext: true, ...whisperBits });
  assert.deepEqual([r.engine, r.fallback], ['whisper', true]);
});

test('4: neither engine — null', () => {
  assert.equal(pickSpeechEngine('webspeech', { isSecureContext: true, Worker: F }).engine, null);
});

test('5: insecure context — null', () => {
  assert.equal(pickSpeechEngine('webspeech', { ...chrome, isSecureContext: false }).engine, null);
});

test('6: error messages are readable', () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'no-speech', 'NotAllowedError', 'NotFoundError']) {
    assert.ok(speechErrorMessage(code).length > 15, code);
  }
  assert.match(speechErrorMessage('not-allowed'), /microphone/i);
  assert.match(speechErrorMessage('weird-code'), /weird-code/);
});
