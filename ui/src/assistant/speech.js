// =============================================================================
// speech — which voice-input engine this browser can run, and readable errors.
// Web Speech (Chrome sends audio to a speech service; Safari is prefixed) is
// the default; Whisper on this device (MediaRecorder + a wasm worker) is the
// alternative and the fallback. Both need a secure context.
// Pure: globals are passed in.
// =============================================================================

export function pickSpeechEngine(pref, g) {
  const secure = g.isSecureContext !== false;
  const webspeech = secure && !!(g.SpeechRecognition || g.webkitSpeechRecognition);
  const whisper = secure && !!(g.MediaRecorder && g.navigator?.mediaDevices?.getUserMedia
    && (g.AudioContext || g.webkitAudioContext) && g.Worker && g.WebAssembly);
  const order = pref === 'whisper' ? ['whisper', 'webspeech'] : ['webspeech', 'whisper'];
  const engine = order.find(e => (e === 'whisper' ? whisper : webspeech)) ?? null;
  return { engine, fallback: !!engine && engine !== order[0], available: { webspeech, whisper } };
}

const MESSAGES = {
  'not-allowed': 'Microphone access was blocked. Allow the microphone for this site and try again.',
  NotAllowedError: 'Microphone access was blocked. Allow the microphone for this site and try again.',
  'service-not-allowed': 'This browser does not allow its speech service here. Try Whisper (on this device) in Settings.',
  'audio-capture': 'No microphone was found, or it is in use by another app.',
  NotFoundError: 'No microphone was found, or it is in use by another app.',
  network: 'The browser\'s speech service could not be reached. Try Whisper (on this device) in Settings.',
  'no-speech': 'No speech was heard. Press the mic and try again.',
  'language-not-supported': 'The browser\'s speech service does not support this language.',
};

export const speechErrorMessage = (code) => MESSAGES[code] || `Speech input failed (${code}).`;
