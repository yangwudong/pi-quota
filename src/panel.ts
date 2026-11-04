/**
 * The quota panel's terminal lines, from the display lines of src/format.ts. Pure apart from the
 * injected `Paint` (pi-tui's width and the theme's colors in pi; plain stand-ins in tests):
 *
 * - the floating card: a dim `│` edge, then each line padded to the card's width;
 * - the lines above the editor: as before.
 *
 * In both the provider name is painted in the provider color and the rest by its tone. The card
 * has no background color: pi hands extensions themes whose background tokens are often the
 * terminal default, so a background would vanish for some users and clash for others. The card
 * still covers the chat beneath it, since every one of its cells is drawn.
 */
import type { DisplayLine, Tone } from "./format.ts";
import { CARD_PADDING } from "./layout.ts";

/** The provider names' color: a clear blue on dark and light themes alike. */
export const PROVIDER_COLOR_HEX = "#008AFA";

/** The card's left edge, one column, drawn dim. */
export const CARD_EDGE = "│";

export type Paint = {
  /** Display columns of a plain string: wide characters (⏳, CJK) count 2. */
  width(text: string): number;
  /** The provider name, in the provider color. */
  name(text: string): string;
  /** The rest of a line, by its tone. */
  tone(tone: Tone, text: string): string;
  /** The card's edge. */
  edge(text: string): string;
};

/** One line, name and rest painted, with nothing around it. */
function painted(line: DisplayLine, paint: Paint): string {
  return `${paint.name(line.name)}${paint.tone(line.tone, line.rest)}`;
}

/**
 * The floating card: every line exactly `width` columns, its edge, the padding, the line and a
 * fill, so the card covers its whole rectangle over the chat.
 */
export function cardLines(lines: readonly DisplayLine[], paint: Paint, width: number): string[] {
  const pad = " ".repeat(CARD_PADDING);
  return lines.map((line) => {
    const fill = " ".repeat(Math.max(0, width - paint.width(line.text) - 2 * CARD_PADDING));
    return `${paint.edge(CARD_EDGE)}${pad}${painted(line, paint)}${fill}`;
  });
}

/** The lines above the editor, one column in like pi's own widget text. */
export function inlineLines(lines: readonly DisplayLine[], paint: Paint): string[] {
  return lines.map((line) => ` ${painted(line, paint)}`);
}
