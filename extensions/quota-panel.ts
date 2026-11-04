/**
 * The quota panel in pi's TUI.
 *
 * - Floating (default): a card at the bottom right of the chat, right above pi's editor area, drawn
 *   as a pi-tui overlay that takes no rows and no keyboard input (`nonCapturing`): the chat and the
 *   editor keep their place. It sits on the chat's last row, so it moves up with pi's editor area
 *   when the input grows or a status line or a menu opens, and one row more while pi shows "Jump to
 *   latest message" on that row.
 * - Inline: lines above the editor (`/quota config` → quota panel), and the fallback whenever the
 *   card cannot float: a terminal too narrow or short, pi's regular mode, or a pi-tui without the
 *   chat accessor below.
 *
 * The panel is a widget (the only place pi hands an extension its `tui`); the floating card is an
 * overlay owned by that widget, so pi's own widget lifecycle (replaced, cleared on a session switch
 * or reload) removes the card with it. Outside the TUI (RPC) the panel is plain text lines.
 *
 * Two pi-tui details shape the card:
 * - pi-tui has no public accessor for the chat area. Its internal `getPrimaryScrollView()` is probed
 *   at run time; without it the panel stays inline. The layout pass sizes the chat before overlays
 *   are composited, so the card's row is current for the frame.
 * - pi-tui treats any visible overlay, capturing or not, as covering the screen for the mouse: text
 *   selection falls back to screen cells, so a copy picks up the card's text, and the scrollbar
 *   takes no drags. So the card says it is visible only while a frame is drawn: from the widget's
 *   render(), early in the frame, to the end of that task, which composites the overlays.
 */
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isViewportTUI,
  type OverlayHandle,
  type OverlayOptions,
  parseColor,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { DisplayLine, Tone } from "../src/format.ts";
import { type CardSpot, cardSpot, cardWidth, floats, type PanelPlacement } from "../src/layout.ts";
import { cardLines, inlineLines, type Paint, PROVIDER_COLOR_HEX } from "../src/panel.ts";

export const WIDGET_KEY = "quota";

const PROVIDER_COLOR = parseColor(PROVIDER_COLOR_HEX);

const TONE_COLORS: Readonly<Record<Tone, ThemeColor>> = {
  normal: "muted",
  warning: "warning",
  low: "error",
  error: "error",
};

/** Colors through the theme: pi converts them to truecolor or 256 colors for the terminal. */
function paintWith(theme: Theme): Paint {
  return {
    width: (text) => visibleWidth(text),
    name: (text) => theme.style(text, { fg: PROVIDER_COLOR }),
    tone: (tone, text) => theme.fg(TONE_COLORS[tone], text),
    edge: (text) => theme.fg("dim", text),
  };
}

/** What the card reads from pi-tui's chat ScrollView, all public on it. */
type ChatView = {
  readonly viewportHeight: number;
  readonly followEnd: boolean;
  readonly isFollowingEnd: boolean;
  readonly scrollbar: string;
};

/** An internal API's answer: the same fields, checked before use. */
type ChatViewLike = { readonly [K in keyof ChatView]?: unknown };

/** pi-tui's fullscreen TUI with its internal accessor for the chat (no public one exists). */
type WithChatAccessor = TUI & { getPrimaryScrollView?(): ChatViewLike | null | undefined };

function hasChatAccessor(tui: TUI): boolean {
  return (tui as WithChatAccessor).getPrimaryScrollView !== undefined;
}

function isChatView(view: ChatViewLike | null | undefined): view is ChatView {
  return (
    view !== undefined &&
    view !== null &&
    typeof view.viewportHeight === "number" &&
    typeof view.followEnd === "boolean" &&
    typeof view.isFollowingEnd === "boolean" &&
    typeof view.scrollbar === "string"
  );
}

/** pi's chat view; undefined without the accessor, or before pi's layout has been drawn. */
function chatViewOf(tui: TUI): ChatView | undefined {
  const view = (tui as WithChatAccessor).getPrimaryScrollView?.();
  // Until pi's layout has been drawn, pi-tui answers with an empty stand-in view.
  return isChatView(view) && view.viewportHeight > 0 ? view : undefined;
}

class QuotaPanel implements Component {
  #lines: readonly DisplayLine[] = [];
  #placement: PanelPlacement = "float";
  #disposed = false;
  /** Set by render() for the frame being drawn. */
  #floating = false;
  /** True from render() to the end of its task: a frame is being drawn. */
  #drawing = false;
  /** The card's place in the frame being drawn; undefined while it does not show. */
  #spot: CardSpot | undefined;
  /** pi's chat view, kept: for a frame after a full redraw pi-tui answers with a stand-in. */
  #chat: ChatView | undefined;
  #overlay: OverlayHandle | undefined;
  readonly #tui: TUI;
  readonly #paint: Paint;
  readonly #canFloat: boolean;
  readonly #card: Component;
  readonly #options: OverlayOptions;

  constructor(tui: TUI, theme: Theme) {
    this.#tui = tui;
    this.#paint = paintWith(theme);
    this.#canFloat = isViewportTUI(tui) && hasChatAccessor(tui);
    this.#card = {
      render: (width) => cardLines(this.#lines, this.#paint, width),
      invalidate: () => {},
    };
    const width = () => this.#width();
    const spot = () => this.#spot;
    this.#options = {
      nonCapturing: true,
      anchor: "bottom-right",
      // Read on every render: the card follows its widest line and the chat's last row.
      get width() {
        return width();
      },
      get row() {
        return spot()?.row ?? 0;
      },
      get margin() {
        return { right: spot()?.right ?? 0 };
      },
      visible: () => this.#visible(),
    };
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  update(lines: readonly DisplayLine[], placement: PanelPlacement): void {
    this.#lines = lines;
    this.#placement = placement;
    this.#syncOverlay();
    this.#tui.requestRender();
  }

  /** The overlay exists only while floating is chosen: pi switches TUI modes only without one. */
  #syncOverlay(): void {
    const wanted = this.#canFloat && !this.#disposed && this.#placement === "float";
    if (wanted && !this.#overlay) this.#overlay = this.#tui.showOverlay(this.#card, this.#options);
    if (!wanted && this.#overlay) {
      this.#overlay.hide();
      this.#overlay = undefined;
    }
  }

  #width(): number {
    return cardWidth(this.#lines.map((line) => visibleWidth(line.text)));
  }

  #chatView(): ChatView | undefined {
    this.#chat = chatViewOf(this.#tui) ?? this.#chat;
    return this.#chat;
  }

  /** Asked while overlays are composited, after the layout pass has sized the chat for the frame. */
  #visible(): boolean {
    const chat = this.#drawing && this.#floating ? this.#chatView() : undefined;
    this.#spot = chat
      ? cardSpot(
          { rows: chat.viewportHeight, scrolledUp: chat.followEnd && !chat.isFollowingEnd, scrollbar: chat.scrollbar },
          this.#lines.length,
        )
      : undefined;
    return this.#spot !== undefined;
  }

  /** pi-tui draws the widget early in a frame and composites overlays later in the same task. */
  #markDrawing(): void {
    if (this.#drawing) return;
    this.#drawing = true;
    queueMicrotask(() => {
      this.#drawing = false;
    });
  }

  /** Above the editor: nothing while the card floats, else the lines themselves. */
  render(width: number): string[] {
    this.#markDrawing();
    const { columns, rows } = this.#tui.terminal;
    this.#floating =
      this.#overlay !== undefined &&
      this.#chatView() !== undefined &&
      floats(this.#placement, { columns, rows }, { width: this.#width(), height: this.#lines.length });
    if (this.#floating) return [];
    return inlineLines(this.#lines, this.#paint).map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    this.#disposed = true;
    this.#syncOverlay();
  }
}

export type PanelHost = {
  /** Shows the lines (pi's TUI: floating or inline; RPC: plain text), or removes the panel. */
  show(ctx: ExtensionContext, lines: readonly DisplayLine[] | undefined, placement: PanelPlacement): void;
};

export function createPanelHost(): PanelHost {
  let panel: QuotaPanel | undefined;
  return {
    show(ctx, lines, placement) {
      if (!lines) {
        // pi disposes the widget, and the widget its floating card.
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        panel = undefined;
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.setWidget(WIDGET_KEY, lines.map((line) => line.text));
        return;
      }
      if (panel && !panel.disposed) {
        panel.update(lines, placement);
        return;
      }
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        const created = new QuotaPanel(tui, theme);
        created.update(lines, placement);
        panel = created;
        return created;
      });
    },
  };
}
