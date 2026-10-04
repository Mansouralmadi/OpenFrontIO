import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import "./NavUtilityIcons";

@customElement("play-page")
export class PlayPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div
        id="page-play"
        class="flex flex-col flex-1 justify-center gap-4 w-full px-0 lg:px-4 min-h-0"
      >
        <token-login class="absolute"></token-login>

        <!-- Mobile: Fixed top bar -->
        <div
          class="lg:hidden fixed left-0 right-0 top-0 z-40 pt-[env(safe-area-inset-top)] bg-surface border-b border-white/10"
        >
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center h-14 px-2 gap-2"
          >
            <button
              id="hamburger-btn"
              class="col-start-1 justify-self-start h-10 shrink-0 aspect-[4/3] flex text-white/90 rounded-md items-center justify-center transition-colors"
              data-i18n-aria-label="main.menu"
              aria-expanded="false"
              aria-controls="sidebar-menu"
              aria-haspopup="dialog"
              data-i18n-title="main.menu"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-8"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            </button>

            <div
              class="col-start-2 flex items-center justify-center text-malibu-blue min-w-0"
            >
              <img
                src=${assetUrl("images/OpenFrontLogo.svg")}
                alt="OpenFront"
                class="h-full w-auto"
              />
            </div>

            <!-- Right slot: help, settings. -->
            <div
              class="col-start-3 justify-self-end shrink-0 flex items-center gap-0.5"
            >
              <nav-utility-icons size="mobile"></nav-utility-icons>
            </div>
          </div>
        </div>

        <!-- Mobile: spacer for fixed top bar -->
        <div class="lg:hidden h-[calc(env(safe-area-inset-top)+56px)]"></div>

        <!-- Identity row: the name used in solo and lobby games. -->
        <div
          class="w-full max-w-2xl mx-auto px-4 sm:px-0 flex items-center bg-surface border-y border-white/10 sm:min-h-[60px] sm:border-y-0 sm:rounded-xl"
        >
          <div class="flex h-full w-full min-w-0 items-center p-1">
            <username-input
              class="flex-1 min-w-0 h-10 sm:h-[50px]"
            ></username-input>
          </div>
        </div>

        <game-mode-selector></game-mode-selector>
      </div>
    `;
  }
}
