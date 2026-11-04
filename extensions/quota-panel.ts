/**
 * The quota panel in pi's TUI.
 *
 * - Floating (default): a card at the top right, drawn as a pi-tui overlay that takes no rows and
 *   no keyboard input (`nonCapturing`): the chat and the editor keep their place. The overlay's
 *   `visible()` decides on every render whether the terminal is wide and tall enough; when it is
 *   not, the same lines go above the editor until it is again.
 * - Inline: lines above the editor (`/quota config` → quota panel).
 *
 * The panel is a widget (the only place pi hands an extension its `tui`); the floating card is an
 * overlay owned by that widget, so pi's own widget lifecycle (replaced, cleared on a session
 * switch or reload) removes the card with it. Floating needs pi's fullscreen viewport: in pi's
 * regular mode an overlay pads the screen to its full height, so there the panel stays inline.
 * Outside the TUI (RPC) the panel is plain text lines.
 */
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isViewportTUI,
  type OverlayHandle,
  parseColor,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { DisplayLine, Tone } from "../src/format.ts";
import { CARD_MARGIN, cardWidth, floats, type PanelPlacement } from "../src/layout.ts";
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

class QuotaPanel implements Component {
  #lines: readonly DisplayLine[] = [];
  #placement: PanelPlacement = "float";
  #disposed = false;
  readonly #tui: TUI;
  readonly #paint: Paint;
  readonly #overlay: OverlayHandle | undefined;

  constructor(tui: TUI, theme: Theme) {
    this.#tui = tui;
    this.#paint = paintWith(theme);
    if (!isViewportTUI(tui)) return;
    const card: Component = {
      render: (width) => cardLines(this.#lines, this.#paint, width),
      invalidate: () => {},
    };
    const width = () => this.#width();
    this.#overlay = tui.showOverlay(card, {
      nonCapturing: true,
      anchor: "top-right",
      margin: { ...CARD_MARGIN },
      // Read on every render, so the card follows its widest line.
      get width() {
        return width();
      },
      visible: (columns, rows) => this.#floats(columns, rows),
    });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  update(lines: readonly DisplayLine[], placement: PanelPlacement): void {
    this.#lines = lines;
    this.#placement = placement;
    this.#tui.requestRender();
  }

  #width(): number {
    return cardWidth(this.#lines.map((line) => visibleWidth(line.text)));
  }

  #floats(columns: number, rows: number): boolean {
    if (this.#disposed || !this.#overlay) return false;
    return floats(this.#placement, { columns, rows }, { width: this.#width(), height: this.#lines.length });
  }

  /** Above the editor: nothing while the card floats, else the lines themselves. */
  render(width: number): string[] {
    const { columns, rows } = this.#tui.terminal;
    if (this.#floats(columns, rows)) return [];
    return inlineLines(this.#lines, this.#paint).map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    this.#disposed = true;
    this.#overlay?.hide();
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
