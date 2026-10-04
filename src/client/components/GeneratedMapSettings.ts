import { html, LitElement, PropertyValues } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import {
  generateTerrain,
  RandomMapParams,
  RandomMapSize,
  RandomMapStyle,
} from "../../core/game/RandomMapGenerator";
import { translateText } from "../Utils";

const PREVIEW_W = 400;
const PREVIEW_H = 200;

// Literal keys so the translation-sync test can see them.
const STYLE_LABELS: Record<RandomMapStyle, string> = {
  continents: "generated_map.styles.continents",
  pangaea: "generated_map.styles.pangaea",
  archipelago: "generated_map.styles.archipelago",
  inland_sea: "generated_map.styles.inland_sea",
  fractal: "generated_map.styles.fractal",
};
const SIZE_LABELS: Record<RandomMapSize, string> = {
  small: "generated_map.sizes.small",
  medium: "generated_map.sizes.medium",
  large: "generated_map.sizes.large",
};

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

/**
 * Civ-style world setup for GameMapType.Generated: style, size, land and
 * mountain sliders, seed, and a live preview. Emits "generated-map-changed".
 */
@customElement("generated-map-settings")
export class GeneratedMapSettings extends LitElement {
  @property({ attribute: false }) params!: RandomMapParams;
  @query("canvas") private canvas?: HTMLCanvasElement;

  createRenderRoot() {
    return this;
  }

  private emitChange(patch: Partial<RandomMapParams>) {
    this.dispatchEvent(
      new CustomEvent("generated-map-changed", {
        detail: { ...this.params, ...patch },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected updated(changed: PropertyValues) {
    if (changed.has("params")) this.drawPreview();
  }

  private drawPreview() {
    const ctx = this.canvas?.getContext("2d");
    if (!ctx) return;
    // Same shapes as the real map (they're resolution independent), minus
    // the tiny-island/lake cleanup.
    const t = generateTerrain(this.params, PREVIEW_W, PREVIEW_H);
    const img = ctx.createImageData(PREVIEW_W, PREVIEW_H);
    for (let i = 0; i < t.type.length; i++) {
      const m = t.mag[i];
      const [r, g, b] = !t.type[i]
        ? [30, 70, 130]
        : m < 10
          ? [190, 220 - 2 * m, 138]
          : m < 20
            ? [200 + 2 * m, 183 + 2 * m, 138 + 2 * m]
            : [240, 240, 240];
      img.data.set([r, g, b, 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
  }

  private slider(
    labelKey: string,
    value: number,
    min: number,
    max: number,
    onInput: (v: number) => void,
    suffix = "",
  ) {
    return html`<label class="flex flex-col gap-1 text-sm text-white/80">
      <span class="flex justify-between">
        <span>${translateText(labelKey)}</span
        ><span class="text-white">${value}${suffix}</span>
      </span>
      <input
        type="range"
        min=${min}
        max=${max}
        .value=${String(value)}
        @input=${(e: Event) =>
          onInput(Number((e.target as HTMLInputElement).value))}
        class="accent-malibu-blue"
      />
    </label>`;
  }

  private choice<T extends string>(
    labelKey: string,
    labels: Record<T, string>,
    selected: T,
    onPick: (v: T) => void,
  ) {
    return html`<div class="flex flex-col gap-1 text-sm text-white/80">
      <span>${translateText(labelKey)}</span>
      <div class="flex flex-wrap gap-2">
        ${(Object.keys(labels) as T[]).map(
          (o) =>
            html`<button
              type="button"
              @click=${() => onPick(o)}
              class="px-3 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wider transition-all ${o ===
              selected
                ? "bg-malibu-blue/20 border-malibu-blue/50 text-white"
                : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"}"
            >
              ${translateText(labels[o])}
            </button>`,
        )}
      </div>
    </div>`;
  }

  render() {
    const p = this.params;
    return html`<div
      class="grid gap-4 md:grid-cols-2 p-4 mb-4 rounded-xl border border-malibu-blue/30 bg-white/5"
    >
      <canvas
        width=${PREVIEW_W}
        height=${PREVIEW_H}
        class="w-full rounded-lg border border-white/10"
        style="image-rendering: pixelated"
      ></canvas>
      <div class="flex flex-col gap-3">
        ${this.choice("generated_map.style", STYLE_LABELS, p.style, (style) =>
          this.emitChange({ style }),
        )}
        ${this.choice("generated_map.size", SIZE_LABELS, p.size, (size) =>
          this.emitChange({ size }),
        )}
        ${this.slider(
          "generated_map.land",
          p.landPercent,
          10,
          85,
          (landPercent) => this.emitChange({ landPercent }),
          "%",
        )}
        ${this.slider(
          "generated_map.mountains",
          p.mountains,
          0,
          100,
          (mountains) => this.emitChange({ mountains }),
        )}
        ${this.slider("generated_map.rivers", p.rivers, 0, 100, (rivers) =>
          this.emitChange({ rivers }),
        )}
        <div class="flex items-center gap-2 text-sm text-white/80">
          <span>${translateText("generated_map.seed")}</span>
          <input
            type="number"
            min="0"
            .value=${String(p.seed)}
            @change=${(e: Event) =>
              this.emitChange({
                seed: Math.max(
                  0,
                  Math.floor(Number((e.target as HTMLInputElement).value)) || 0,
                ),
              })}
            class="w-36 px-2 py-1 rounded-lg bg-transparent border border-white/10 text-white"
          />
          <button
            type="button"
            @click=${() => this.emitChange({ seed: randomSeed() })}
            class="px-3 py-1 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white"
            title=${translateText("generated_map.reroll")}
          >
            🎲 ${translateText("generated_map.reroll")}
          </button>
        </div>
      </div>
    </div>`;
  }
}
