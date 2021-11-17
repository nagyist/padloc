import "./button";
import "./scroller";
import { html, LitElement } from "lit";
import { StateMixin } from "../mixins/state";
import { router } from "../globals";
import { translate as $l } from "@padloc/locale/src/translate";
import { customElement } from "lit/decorators.js";
import { shared } from "../styles";
import { Select } from "./select";

@customElement("pl-settings-display")
export class SettingsDisplay extends StateMixin(LitElement) {
    static styles = [shared];

    connectedCallback() {
        super.connectedCallback();
        this.addEventListener("change", () => this._updateSettings());
    }

    private _updateSettings() {
        this.app.setSettings({
            theme:
                (this.renderRoot.querySelector("#themeSelect") as Select<"auto" | "light" | "dark">).value || undefined,
        });
    }

    render() {
        return html`
            <div class="fullbleed vertical layout stretch background">
                <header class="padded center-aligning horizontal layout">
                    <pl-button class="transparent slim back-button" @click=${() => router.go("settings")}>
                        <pl-icon icon="backward"></pl-icon>
                    </pl-button>
                    <pl-icon icon="display" class="left-margined vertically-padded wide-only"></pl-icon>
                    <div class="padded stretch ellipsis">${$l("Display")}</div>
                </header>

                <pl-scroller class="stretch">
                    <div class="double-margined box">
                        <h2 class="padded uppercase bg-dark border-bottom semibold">${$l("Theme")}</h2>

                        <pl-select
                            class="transparent"
                            .options=${[{ value: "auto" }, { value: "light" }, { value: "dark" }]}
                            id="themeSelect"
                            .value=${this.state.settings.theme as any}
                        ></pl-select>
                    </div>
                </pl-scroller>
            </div>
        `;
    }
}
