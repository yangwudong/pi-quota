import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DisplayLine, Tone } from "../src/format.ts";
import { CARD_PADDING, CARD_TOP, cardSpot, cardWidth, DEFAULT_PLACEMENT, floats, isPlacement, MIN_CHAT_COLUMNS, MIN_FREE_ROWS } from "../src/layout.ts";
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
  it("floats at the top right by default; bottom right and above the editor are the other choices", () => {
    assert.equal(DEFAULT_PLACEMENT, "top-right");
    assert.equal(isPlacement("top-right"), true);
    assert.equal(isPlacement("bottom-right"), true);
    assert.equal(isPlacement("inline"), true);
    assert.equal(isPlacement("float"), false, "0.3.x's value reads as the default");
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
    for (const corner of ["top-right", "bottom-right"] as const) {
      assert.equal(floats(corner, wide, card), true);
      assert.equal(floats(corner, { ...wide, columns: wide.columns - 1 }, card), false, "too narrow");
      const tall = { columns: 140, rows: card.height + MIN_FREE_ROWS };
      assert.equal(floats(corner, tall, card), true);
      assert.equal(floats(corner, { ...tall, rows: tall.rows - 1 }, card), false, "too short");
      assert.equal(floats(corner, wide, { width: 46, height: 0 }), false, "nothing to show");
    }
    assert.equal(floats("inline", wide, card), false, "chosen above the editor");
  });

  it("top right: from row 1 down (row 0 is pi-tui's flash row), wherever the editor area is", () => {
    assert.deepEqual(cardSpot({ rows: 26, scrolledUp: false, scrollbar: "auto" }, 4, "top-right"), { row: CARD_TOP, right: 0 });
    assert.deepEqual(cardSpot({ rows: 12, scrolledUp: true, scrollbar: "always" }, 4, "top-right"), { row: CARD_TOP, right: 1 });
    // A tall menu left 5 chat rows: rows 1-4 fit; with "Jump to latest message" on row 4 they do not.
    assert.deepEqual(cardSpot({ rows: 5, scrolledUp: false, scrollbar: "auto" }, 4, "top-right"), { row: 1, right: 0 });
    assert.equal(cardSpot({ rows: 5, scrolledUp: true, scrollbar: "auto" }, 4, "top-right"), undefined);
    assert.equal(cardSpot({ rows: 4, scrolledUp: false, scrollbar: "auto" }, 4, "top-right"), undefined);
  });

  it("bottom right: on the chat's last row, right above pi's editor area, flush right", () => {
    // A 32-row terminal whose chat has 26 rows (0-25): the card's 4 rows are 22-25.
    assert.deepEqual(cardSpot({ rows: 26, scrolledUp: false, scrollbar: "auto" }, 4, "bottom-right"), { row: 22, right: 0 });
    // The editor grew, or a status line or a menu opened: the chat is shorter, the card moves up.
    assert.deepEqual(cardSpot({ rows: 20, scrolledUp: false, scrollbar: "auto" }, 4, "bottom-right"), { row: 16, right: 0 });
  });

  it("bottom right: steps up a row for pi's 'Jump to latest message', leaves an always-on scrollbar its column", () => {
    assert.deepEqual(cardSpot({ rows: 26, scrolledUp: true, scrollbar: "auto" }, 4, "bottom-right"), { row: 21, right: 0 });
    assert.deepEqual(cardSpot({ rows: 26, scrolledUp: false, scrollbar: "always" }, 4, "bottom-right"), { row: 22, right: 1 });
  });

  it("bottom right: does not show while the chat is too short to hold it, rather than cover the editor area", () => {
    const spot = (rows: number, scrolledUp: boolean, height = 4) =>
      cardSpot({ rows, scrolledUp, scrollbar: "auto" }, height, "bottom-right");
    assert.deepEqual(spot(4, false), { row: 0, right: 0 }, "exactly fits");
    assert.equal(spot(3, false), undefined);
    assert.equal(spot(4, true), undefined, "the jump label takes a row");
    assert.equal(spot(26, false, 0), undefined, "nothing to show");
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
