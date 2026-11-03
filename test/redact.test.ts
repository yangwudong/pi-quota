import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTED, redactSecrets, replaceSecretValues, safeText, singleLine } from "../src/core/redact.ts";

const ZHIPU_KEY = "0123456789abcdef0123456789abcdef.SecretPart123456";
const GH_TOKEN = "ghu_TestOAuthToken0123456789abcdefABCDEF";

describe("redact", () => {
  it("replaces the caller's own secrets wherever they appear", () => {
    assert.equal(safeText(`key=${ZHIPU_KEY}, again: ${ZHIPU_KEY}`, [ZHIPU_KEY]), `key=${REDACTED}, again: ${REDACTED}`);
  });

  it("replaces a short secret only as a whole token, so no word is cut", () => {
    assert.equal(replaceSecretValues("abc abcdef xabc", ["abc"]), `${REDACTED} abcdef xabc`);
  });

  it("hides credential shapes even without knowing the secret", () => {
    const cases: Array<[string, string]> = [
      [`Authorization: Bearer ${GH_TOKEN}`, `Authorization: ${REDACTED}`],
      [`rejected Bearer ${GH_TOKEN} here`, `rejected Bearer ${REDACTED} here`],
      [`token ${GH_TOKEN}`, `token ${REDACTED}`],
      [`Zhipu said ${ZHIPU_KEY} is wrong`, `Zhipu said ${REDACTED} is wrong`],
      ['{"access_token":"abc.def","name":"ok"}', `{"access_token":${REDACTED},"name":"ok"}`],
      ["copilot tid=abc123;exp=1793000000;sku=x:y", `copilot ${REDACTED}`],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", `jwt ${REDACTED}`],
      [`opaque ${"a1B2".repeat(10)}`, `opaque ${REDACTED}`],
    ];
    for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
  });

  it("keeps ordinary words, model names and facts about secrets", () => {
    for (const text of [
      "身份验证失败。",
      "Bad credentials (https://docs.github.com/rest)",
      "token expired",
      "api_key_source=env",
      "Qwen3-Coder-480B-A35B-Instruct-FP8-preview-long-model-name",
    ]) {
      assert.equal(redactSecrets(text), text, text);
    }
  });

  it("makes provider text one plain line before anything else", () => {
    assert.equal(singleLine("\u001b[31mred\u001b[0m\n  text\u0007"), "red text");
    // Cut to length last; one long opaque run would be a token instead (see above).
    assert.equal(safeText("word ".repeat(100)).length, 160);
    assert.equal(safeText("x".repeat(500)), REDACTED);
  });
});
