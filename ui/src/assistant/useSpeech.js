import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pickSpeechEngine, speechErrorMessage } from './speech';

/**
 * Voice input. Web Speech: interim text streams into the input and ends on a
 * pause. Whisper: the mic records until pressed again, then MediaRecorder →
 * 16 kHz mono PCM → asr.worker.js (on this device). `onText` sets the input;
 * `onFinal` gets the finished text (the panel sends it only with auto-send).
 */
export function useSpeech({ pref, onText, onFinal, onError, onStatus }) {
  const pick = useMemo(() => pickSpeechEngine(pref, globalThis), [pref]);
  const [listening, setListening] = useState(false);
  const active = useRef(null);
  const worker = useRef(null);
  const cbs = useRef(null);
  useLayoutEffect(() => { cbs.current = { onText, onFinal, onError, onStatus }; });
  useEffect(() => () => {
    active.current?.abort();
    worker.current?.terminate();
  }, []);

  const startWebSpeech = () => {
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    const r = new SR();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let text = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      cbs.current.onText(text + interim);
    };
    r.onerror = (e) => { if (e.error !== 'aborted') cbs.current.onError(speechErrorMessage(e.error)); };
    r.onend = () => {
      active.current = null;
      setListening(false);
      if (text.trim()) cbs.current.onFinal(text.trim());
    };
    try {
      r.start();
    } catch (e) {
      cbs.current.onError(`Speech input could not start: ${e?.message || e}`);
      return;
    }
    active.current = { stop: () => r.stop(), abort: () => r.abort() };
    setListening(true);
    cbs.current.onStatus('Listening…');
  };

  const transcribe = async (blob) => {
    let ctx;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      ctx = new AC({ sampleRate: 16000 });
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      // Copied before transfer, so no AudioBuffer storage is detached.
      const pcm = buf.getChannelData(0).slice();
      cbs.current.onStatus('Transcribing…');
      worker.current ??= new Worker(new URL('./asr.worker.js', import.meta.url), { type: 'module' });
      worker.current.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          if (data.p?.status === 'initiate') cbs.current.onStatus('Downloading Whisper (about 41 MB, once)…');
        } else if (data.type === 'text') {
          const t = data.text.trim();
          cbs.current.onText(t);
          if (t) cbs.current.onFinal(t);
          else cbs.current.onStatus('No speech was heard.');
        } else {
          cbs.current.onError(`Whisper failed: ${data.message}`);
        }
      };
      // A worker that fails to load, or crashes, posts nothing: say so, and start a fresh one next time.
      worker.current.onerror = (e) => {
        worker.current?.terminate();
        worker.current = null;
        cbs.current.onError(`Whisper failed: ${e?.message || 'the speech worker stopped'}`);
      };
      worker.current.postMessage(pcm, [pcm.buffer]);
    } catch (e) {
      cbs.current.onError(`Could not read the recording: ${e?.message || e}`);
    } finally {
      ctx?.close();   // also when decoding fails; each failed recording would leak an audio context
    }
  };

  const startWhisper = async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      cbs.current.onError(speechErrorMessage(e?.name || 'audio-capture'));
      return;
    }
    const stopTracks = () => stream.getTracks().forEach(t => t.stop());
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      stopTracks();
      active.current = null;
      setListening(false);
      transcribe(new Blob(chunks, { type: recorder.mimeType }));
    };
    active.current = {
      stop: () => recorder.stop(),
      abort: () => { recorder.onstop = null; if (recorder.state !== 'inactive') recorder.stop(); stopTracks(); },
    };
    recorder.start();
    setListening(true);
    cbs.current.onStatus('Listening… press the mic again to stop.');
  };

  const toggle = () => {
    if (active.current) { active.current.stop(); return; }
    if (pick.engine === 'webspeech') startWebSpeech();
    else if (pick.engine === 'whisper') startWhisper();
  };

  return { engine: pick.engine, fallback: pick.fallback, available: pick.available, listening, toggle };
}
