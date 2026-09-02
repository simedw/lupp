import test from "node:test";
import assert from "node:assert/strict";
import { keySettings, unlockSecret } from "../desktop/secrets.js";

const stored = Buffer.from("test ciphertext").toString("base64");
const available = (decryptString: (bytes: Buffer) => string) => ({ isEncryptionAvailable: () => true, decryptString });

test("old-identity ciphertext is not reported as a configured key", () => {
  const storage = available(() => { throw new Error("private low-level decryption details"); });
  const config = { apiKey: stored, anthropicApiKey: stored };
  const status = keySettings(storage, config, true);
  assert.equal(status.apiKeyConfigured, false);
  assert.equal(status.anthropicApiKeyConfigured, false);
  assert.match(status.apiKeyError || "", /Open SET and re-enter/);
  assert.match(status.anthropicApiKeyError || "", /Anthropic key/);
  assert.doesNotMatch(JSON.stringify(status), /private low-level|test ciphertext/);
  assert.deepEqual(config, { apiKey: stored, anthropicApiKey: stored });
});

test("replacing an unreadable key restores configured status without exposing plaintext", () => {
  const replacement = Buffer.from("new identity").toString("base64");
  const storage = available((bytes) => {
    if (bytes.toString() !== "new identity") throw new Error("wrong identity");
    return "test-plaintext-key";
  });
  assert.equal(keySettings(storage, { apiKey: stored }).apiKeyConfigured, false);
  const status = keySettings(storage, { apiKey: replacement });
  assert.equal(status.apiKeyConfigured, true);
  assert.equal(status.apiKeyError, null);
  assert.doesNotMatch(JSON.stringify(status), /test-plaintext-key/);
  assert.equal(unlockSecret(storage, replacement, "OpenAI key").value, "test-plaintext-key");
});

test("unavailable secure storage offers recovery without decrypting", () => {
  const storage = { isEncryptionAvailable: () => false, decryptString() { assert.fail("must not decrypt"); } };
  const status = keySettings(storage, { apiKey: stored });
  assert.equal(status.apiKeyConfigured, false);
  assert.match(status.apiKeyError || "", /Unlock your system keychain/);
});

test("missing keys and optional environment credentials are distinct from unreadable keys", () => {
  const storage = available(() => assert.fail("no key to decrypt"));
  const status = keySettings(storage, {}, true);
  assert.equal(status.apiKeyConfigured, false);
  assert.equal(status.apiKeyError, null);
  assert.equal(status.anthropicApiKeyConfigured, true);
  assert.equal(status.anthropicApiKeyError, null);
});
