/**
 * Where the quota panel goes in pi's TUI. Pure, so it is tested without pi's TUI.
 *
 * - "float" (default): a card at the top right that floats over the chat. It takes no rows: the
 *   chat and the editor keep their place, and the panel covers only the right side, where the
 *   chat leaves the most room.
 * - "inline": lines above the editor, as in 0.1 and 0.2.
 *
 * A floating card only floats while enough of the chat stays clear beside it; in a narrower
 * terminal it goes back above the editor until the terminal is wide again.
 */
import type { JsonValue } from "./core/json.ts";

export type PanelPlacement = "float" | "inline";
export const PANEL_PLACEMENTS: readonly PanelPlacement[] = ["float", "inline"];
export const DEFAULT_PLACEMENT: PanelPlacement = "float";

export function isPlacement(value: JsonValue | undefined): value is PanelPlacement {
  return typeof value === "string" && (PANEL_PLACEMENTS as readonly string[]).includes(value);
}

/** Columns of chat that must stay clear beside a floating card. */
export const MIN_CHAT_COLUMNS = 40;
/** Rows a terminal must have beyond the card: the editor, the footer and some chat. */
export const MIN_FREE_ROWS = 12;
/** Blank columns inside the card, left and right of its lines. */
export const CARD_PADDING = 1;
/**
 * The card's distance from the top and right edges of the terminal. Flush right: a gap beside the
 * card would let the end of a long chat line show through between the card and the edge.
 */
export const CARD_MARGIN = { top: 1, right: 0 } as const;

/** The card's width: its widest line and the padding on both sides. */
export function cardWidth(lineWidths: readonly number[]): number {
  return Math.max(0, ...lineWidths) + 2 * CARD_PADDING;
}

/**
 * True when the card floats: chosen, with something to show, and the terminal leaves enough chat
 * beside it and enough rows below it.
 */
export function floats(
  placement: PanelPlacement,
  terminal: { columns: number; rows: number },
  card: { width: number; height: number },
): boolean {
  if (placement !== "float" || card.height === 0) return false;
  return (
    terminal.columns - card.width - CARD_MARGIN.right >= MIN_CHAT_COLUMNS &&
    terminal.rows - card.height - CARD_MARGIN.top >= MIN_FREE_ROWS
  );
}
