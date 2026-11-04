/**
 * Where the quota panel goes in pi's TUI. Pure, so it is tested without pi's TUI.
 *
 * - "top-right" (default) / "bottom-right": a card that floats over the chat's top right corner,
 *   or its bottom right corner right above pi's editor area. It takes no rows: the chat and the
 *   editor keep their place, and the card covers only the right end of a few chat rows. At the top
 *   those rows scroll out from under it; at the bottom they are the newest ones.
 * - "inline": lines above the editor, as in 0.1 and 0.2.
 *
 * A floating card only floats while enough of the chat stays clear beside it; in a narrower or
 * shorter terminal it goes back above the editor until there is room again.
 */
import type { JsonValue } from "./core/json.ts";

export type FloatingCorner = "top-right" | "bottom-right";
export type PanelPlacement = FloatingCorner | "inline";
export const PANEL_PLACEMENTS: readonly PanelPlacement[] = ["top-right", "bottom-right", "inline"];
/** 0.3.x saved "float"; it is no longer a placement, so it reads as this default. */
export const DEFAULT_PLACEMENT: PanelPlacement = "top-right";

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
 * The top-right card's first row. Row 0 stays clear: pi-tui flashes notes such as "Copied!" at
 * the top right of the screen.
 */
export const CARD_TOP = 1;

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
  if (placement === "inline" || card.height === 0) return false;
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
 * The card's place in the chat area, flush right: a gap beside it would let the end of a long chat
 * line show through (except for a scrollbar that always takes the last column).
 * - top-right: from row CARD_TOP down;
 * - bottom-right: its last row is the chat's last row, right above pi's editor area.
 * Either way it stays off the chat's last row while pi shows "Jump to latest message" there, and
 * it is undefined while the chat is too short to hold it (e.g. under a tall menu): the card never
 * covers pi's editor area.
 */
export function cardSpot(chat: ChatArea, cardHeight: number, corner: FloatingCorner): CardSpot | undefined {
  const rows = chat.rows - (chat.scrolledUp ? 1 : 0);
  const top = corner === "top-right" ? CARD_TOP : 0;
  const row = corner === "top-right" ? CARD_TOP : rows - cardHeight;
  if (cardHeight <= 0 || row < top || row + cardHeight > rows) return undefined;
  return { row, right: chat.scrollbar === "always" ? 1 : 0 };
}
