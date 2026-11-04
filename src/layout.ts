/**
 * Where the quota panel goes in pi's TUI. Pure, so it is tested without pi's TUI.
 *
 * - "float" (default): a card at the bottom right of the chat, right above pi's editor area. It
 *   takes no rows: the chat and the editor keep their place, and the card covers only the right
 *   end of the chat's last rows, where the chat leaves the most room.
 * - "inline": lines above the editor, as in 0.1 and 0.2.
 *
 * A floating card only floats while enough of the chat stays clear beside it; in a narrower or
 * shorter terminal it goes back above the editor until there is room again.
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

/** The card's width: its widest line and the padding on both sides. */
export function cardWidth(lineWidths: readonly number[]): number {
  return Math.max(0, ...lineWidths) + 2 * CARD_PADDING;
}

/** True when the card floats: chosen, with something to show, and a terminal wide and tall enough. */
export function floats(
  placement: PanelPlacement,
  terminal: { columns: number; rows: number },
  card: { width: number; height: number },
): boolean {
  if (placement !== "float" || card.height === 0) return false;
  return terminal.columns - card.width >= MIN_CHAT_COLUMNS && terminal.rows - card.height >= MIN_FREE_ROWS;
}

/** pi's chat area on screen, as far as the floating card needs it. */
export type ChatArea = {
  /** Rows of chat. The chat starts at the top of the screen; pi's editor area follows it. */
  rows: number;
  /** Scrolled up from the latest message: pi shows "Jump to latest message" on the chat's last row. */
  scrolledUp: boolean;
  /** pi-tui's scrollbar setting: with "always", the chat's last column belongs to the scrollbar. */
  scrollbar: string;
};

/** The card's place on screen: its top row, and its distance from the right edge. */
export type CardSpot = { row: number; right: number };

/**
 * The card's last row is the chat's last row, right above pi's editor area, or the row above it
 * while pi shows "Jump to latest message" there. The card is flush right: a gap beside it would let
 * the end of a long chat line show through. The exception is a scrollbar that always takes the
 * last column. undefined while the chat is too short to hold the card, e.g. under a tall menu.
 */
export function cardSpot(chat: ChatArea, cardHeight: number): CardSpot | undefined {
  const row = chat.rows - (chat.scrolledUp ? 1 : 0) - cardHeight;
  if (cardHeight <= 0 || row < 0) return undefined;
  return { row, right: chat.scrollbar === "always" ? 1 : 0 };
}
