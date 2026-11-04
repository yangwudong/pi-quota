import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DisplayLine, Tone } from "../src/format.ts";
import { CARD_PADDING, cardSpot, cardWidth, floats, isPlacement, MIN_CHAT_COLUMNS, MIN_FREE_ROWS } from "../src/layout.ts";
import { CARD_EDGE, cardLines, inlineLines, type Paint, PROVIDER_COLOR_HEX } from "../src/panel.ts";

/** Plain-text stand-ins that show where each paint goes; ⏳ and CJK count 2 columns, as in pi-tui. */
const paint: Paint = {
  width: (text) => [...text].reduce((sum, ch) => sum + (/[\u23f3\u4e00-\u9fff]/u.test(ch) ? 2 : 1), 0),
  name: (text) => `<n>${text}</n>`,
  tone: (tone: Tone, text) => `<${tone}>${text}</${tone}>`,
  edge: (text) => `<e>${text}</e>`,
};

const line = (name: string, rest: string, tone: Tone = "normal"): DisplayLine => ({ text: `${name}${rest}`, name, rest, tone });

const LINES = [
  line("Zhipu   ", "5h  ▰▰▱▱▱▱▱▱▱▱  18%  ⏳ 1h40m  ⚠ fast", "low"),
  line("Copilot ", "    ▰▰▰▰▰▰▰▰▰▱  87%  ⏳ 27d"),
];

describe("panel placement", () => {
  it("floats by default; 'inline' is the only other choice", () => {
    assert.equal(isPlacement("float"), true);
    assert.equal(isPlacement("inline"), true);
    assert.equal(isPlacement("left"), false);
    assert.equal(isPlacement(3), false);
  });

  it("is as wide as its widest line plus the padding", () => {
    assert.equal(cardWidth([10, 44, 31]), 44 + 2 * CARD_PADDING);
    assert.equal(cardWidth([]), 2 * CARD_PADDING);
  });

  it("floats only while enough chat stays clear beside it and the terminal is tall enough", () => {
    const card = { width: 46, height: 4 };
    const wide = { columns: card.width + MIN_CHAT_COLUMNS, rows: 40 };
    assert.equal(floats("float", wide, card), true);
    assert.equal(floats("float", { ...wide, columns: wide.columns - 1 }, card), false, "too narrow");
    const tall = { columns: 140, rows: card.height + MIN_FREE_ROWS };
    assert.equal(floats("float", tall, card), true);
    assert.equal(floats("float", { ...tall, rows: tall.rows - 1 }, card), false, "too short");
    assert.equal(floats("inline", wide, card), false, "chosen above the editor");
    assert.equal(floats("float", wide, { width: 46, height: 0 }), false, "nothing to show");
  });

  it("sits on the chat's last row, right above pi's editor area, flush right", () => {
    // A 32-row terminal whose chat has 26 rows (0-25): the card's 4 rows are 22-25.
    assert.deepEqual(cardSpot({ rows: 26, scrolledUp: false, scrollbar: "auto" }, 4), { row: 22, right: 0 });
    // The editor grew, or a status line or a menu opened: the chat is shorter, the card moves up.
    assert.deepEqual(cardSpot({ rows: 20, scrolledUp: false, scrollbar: "auto" }, 4), { row: 16, right: 0 });
  });

  it("steps up a row for pi's 'Jump to latest message', and leaves an always-on scrollbar its column", () => {
    assert.deepEqual(cardSpot({ rows: 26, scrolledUp: true, scrollbar: "auto" }, 4), { row: 21, right: 0 });
    assert.deepEqual(cardSpot({ rows: 26, scrolledUp: false, scrollbar: "always" }, 4), { row: 22, right: 1 });
  });

  it("does not show while the chat is too short to hold it, rather than cover the editor area", () => {
    assert.deepEqual(cardSpot({ rows: 4, scrolledUp: false, scrollbar: "auto" }, 4), { row: 0, right: 0 }, "exactly fits");
    assert.equal(cardSpot({ rows: 3, scrolledUp: false, scrollbar: "auto" }, 4), undefined);
    assert.equal(cardSpot({ rows: 4, scrolledUp: true, scrollbar: "auto" }, 4), undefined, "the jump label takes a row");
    assert.equal(cardSpot({ rows: 26, scrolledUp: false, scrollbar: "auto" }, 0), undefined, "nothing to show");
  });
});

describe("panel lines", () => {
  it("paints the provider name in the provider color and the rest by its tone", () => {
    assert.equal(PROVIDER_COLOR_HEX, "#008AFA");
    assert.deepEqual(inlineLines(LINES, paint), [
      " <n>Zhipu   </n><low>5h  ▰▰▱▱▱▱▱▱▱▱  18%  ⏳ 1h40m  ⚠ fast</low>",
      " <n>Copilot </n><normal>    ▰▰▰▰▰▰▰▰▰▱  87%  ⏳ 27d</normal>",
    ]);
  });

  it("draws every card line exactly the card's width (⏳ is 2 columns): edge, padding, line, fill", () => {
    const width = cardWidth(LINES.map((item) => paint.width(item.text)));
    const card = cardLines(LINES, paint, width);
    const plain = card.map((text) => text.replace(/<\/?[a-z]+>/gu, ""));
    assert.deepEqual(plain.map((text) => paint.width(text)), [width, width], "every line exactly the card's width");
    assert.ok(card.every((text) => text.startsWith(`<e>${CARD_EDGE}</e> <n>`)), "a dim edge, then the padding");
    // Zhipu's line is 45 columns, Copilot's 35: Copilot is filled out by 10 to the card's edge.
    assert.match(card[1] ?? "", /⏳ 27d<\/normal> {10}$/u, "the shorter line is filled out");
    assert.match(card[0] ?? "", /fast<\/low>$/u, "the widest line needs no fill");
  });
});
