// =============================================================================
// settings — the assistant's persisted UI choices (csim_ui_assistant) and the
// user's API keys. Keys are data, not choices: their own keys, written only by
// the assistant's settings and removed by Forget key. localStorage is touched
// only inside function bodies, so node can import this file.
// =============================================================================

export const DEFAULT_SETTINGS = {
  provider: 'local',
  localModel: null,            // null: the recommended one
  anthropicModel: 'claude-haiku-5-5',
  openaiModel: 'gpt-6-luna',
  speech: 'webspeech',
  autoSend: false,             // off: tools apply without confirmation
};

const PROVIDERS = ['local', 'anthropic', 'openai'];

export function isAssistantSettings(v) {
  return !!v && typeof v === 'object'
    && PROVIDERS.includes(v.provider)
    && (v.localModel === null || typeof v.localModel === 'string')
    && typeof v.anthropicModel === 'string' && typeof v.openaiModel === 'string'
    && ['webspeech', 'whisper'].includes(v.speech)
    && typeof v.autoSend === 'boolean';
}

const keyName = (provider) => `csim_assistant_key_${provider}`;

export function readKey(provider) {
  try { return localStorage.getItem(keyName(provider)) || ''; } catch { return ''; }
}

/** An empty key removes the stored one. */
export function saveKey(provider, key) {
  try {
    if (key) localStorage.setItem(keyName(provider), key);
    else localStorage.removeItem(keyName(provider));
  } catch { /* storage blocked: the key lasts this session only */ }
}
