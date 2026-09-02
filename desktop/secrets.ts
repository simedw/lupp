type SecretStorage = {
  isEncryptionAvailable(): boolean;
  decryptString(value: Buffer): string;
};

type SecretResult = { value: string; error: string | null };

// Keep plaintext in the main process. Never forward storage exceptions: they may
// contain implementation details or sensitive values from an underlying provider.
export function unlockSecret(storage: SecretStorage, ciphertext: string | undefined, label: string): SecretResult {
  if (!ciphertext) return { value: "", error: null };
  if (!storage.isEncryptionAvailable()) {
    return { value: "", error: `Secure storage is unavailable. Unlock your system keychain and try again (${label}).` };
  }
  try {
    const value = storage.decryptString(Buffer.from(ciphertext, "base64"));
    if (!value.trim()) throw new Error("Empty key");
    return { value, error: null };
  } catch {
    return {
      value: "",
      error: `${label} could not be unlocked. Open SET and re-enter that key, then save settings. This can happen after an app rename or a keychain change.`
    };
  }
}

export function keySettings(storage: SecretStorage, config: { apiKey?: string; anthropicApiKey?: string }, hasAnthropicEnvironmentKey = false) {
  const openai = unlockSecret(storage, config.apiKey, "OpenAI transcription key");
  const anthropic = unlockSecret(storage, config.anthropicApiKey, "Anthropic key");
  return {
    apiKeyConfigured: Boolean(openai.value),
    apiKeyError: openai.error,
    anthropicApiKeyConfigured: Boolean(anthropic.value || (!config.anthropicApiKey && hasAnthropicEnvironmentKey)),
    anthropicApiKeyError: anthropic.error
  };
}
