import { segment, type RequestOptions } from "../core/request";
import type {
  Preset,
  PresetCreateParams,
  PresetList,
  PresetTemplateList,
  PresetUpdateParams,
} from "../types";
import { API, type Caller } from "./shared";

export interface PresetsResource {
  /** Lists fee presets, default first. `GET /presets` */
  list(options?: RequestOptions): Promise<PresetList>;
  /**
   * Creates a fee preset. `*_share` fields are basis points of the project's part of the fee;
   * `fee_bps` in the response gives each party's share of the whole fee. `POST /presets`
   */
  create(params: PresetCreateParams, options?: RequestOptions): Promise<Preset>;
  /** Lists the built-in preset templates. `GET /presets/templates` */
  templates(options?: RequestOptions): Promise<PresetTemplateList>;
  /** `GET /presets/{id}` */
  get(id: string, options?: RequestOptions): Promise<Preset>;
  /** Updates a preset or makes it the default. `PATCH /presets/{id}` */
  update(id: string, params: PresetUpdateParams, options?: RequestOptions): Promise<Preset>;
  /** Archives a preset so new launches cannot use it. `DELETE /presets/{id}` */
  archive(id: string, options?: RequestOptions): Promise<Preset>;
}

const path = (id: string): string => `${API}/presets/${segment(id, "id")}`;

export function presets(call: Caller): PresetsResource {
  return {
    list: async (options) =>
      call({ method: "GET", path: `${API}/presets`, auth: "secret", options }),
    create: async (params, options) =>
      call({ method: "POST", path: `${API}/presets`, body: params, auth: "secret", options }),
    templates: async (options) =>
      call({ method: "GET", path: `${API}/presets/templates`, auth: "secret", options }),
    get: async (id, options) => call({ method: "GET", path: path(id), auth: "secret", options }),
    update: async (id, params, options) =>
      call({ method: "PATCH", path: path(id), body: params, auth: "secret", options }),
    archive: async (id, options) =>
      call({ method: "DELETE", path: path(id), auth: "secret", options }),
  };
}
