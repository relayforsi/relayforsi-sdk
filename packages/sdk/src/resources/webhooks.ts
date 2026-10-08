import { segment, type RequestOptions } from "../core/request";
import { pageQuery, paginate } from "../pagination";
import type {
  Delivery,
  DeliveryList,
  DeliveryListParams,
  NewWebhook,
  Webhook,
  WebhookCreateParams,
  WebhookList,
} from "../types";
import { API, requireSecret, withIdempotencyKey, type Caller } from "./shared";

export interface DeliveriesResource {
  /** Lists deliveries, optionally for one webhook. `GET /webhooks/deliveries` */
  list(params?: DeliveryListParams, options?: RequestOptions): Promise<DeliveryList>;
  /** Iterates over all deliveries. */
  all(
    params?: DeliveryListParams,
    options?: RequestOptions,
  ): AsyncGenerator<Delivery, void, undefined>;
  /** Redelivers an event now. `POST /webhooks/deliveries/{id}/replay` */
  replay(id: string, options?: RequestOptions): Promise<Delivery>;
}

export interface WebhooksResource {
  /**
   * Creates a webhook endpoint (https, at most 5 per project). An empty or missing `events` list
   * subscribes to every event. The signing secret is shown once; a retry with the same
   * Idempotency-Key gets it again. `POST /webhooks`
   */
  create(
    params: WebhookCreateParams,
    options?: RequestOptions,
  ): Promise<NewWebhook & { secret: string }>;
  /** `GET /webhooks/{id}` */
  get(id: string, options?: RequestOptions): Promise<Webhook>;
  /** Lists webhooks (at most 5, not paginated). `GET /webhooks` */
  list(options?: RequestOptions): Promise<WebhookList>;
  /** Deletes a webhook and cancels its pending deliveries. Deleting twice is safe. `DELETE /webhooks/{id}` */
  delete(id: string, options?: RequestOptions): Promise<Webhook>;
  /**
   * Rotates the signing secret. Deliveries are signed with both secrets for 24 hours.
   * `POST /webhooks/{id}/rotate`
   */
  rotate(id: string, options?: RequestOptions): Promise<NewWebhook & { secret: string }>;
  /** Sends a `ping` event. `POST /webhooks/{id}/test` */
  test(id: string, options?: RequestOptions): Promise<Delivery>;
  readonly deliveries: DeliveriesResource;
}

const path = (id: string): string => `${API}/webhooks/${segment(id, "id")}`;

export function webhooks(call: Caller): WebhooksResource {
  const deliveries: DeliveriesResource = {
    list: async (params, options) =>
      call({
        method: "GET",
        path: `${API}/webhooks/deliveries`,
        query: params,
        auth: "secret",
        options,
      }),
    all: (params, options) =>
      paginate((cursor) => deliveries.list(pageQuery(params, cursor), options)),
    replay: async (id, options) =>
      call({
        method: "POST",
        path: `${API}/webhooks/deliveries/${segment(id, "id")}/replay`,
        auth: "secret",
        options,
      }),
  };

  return {
    create: async (params, options) => {
      const sent = withIdempotencyKey(options);
      const created = await call<NewWebhook>({
        method: "POST",
        path: `${API}/webhooks`,
        body: params,
        auth: "secret",
        options: sent,
      });
      return requireSecret(created, "secret", `Rotate ${created.id} to get a new secret.`, sent);
    },
    get: async (id, options) => call({ method: "GET", path: path(id), auth: "secret", options }),
    list: async (options) =>
      call({ method: "GET", path: `${API}/webhooks`, auth: "secret", options }),
    delete: async (id, options) =>
      call({ method: "DELETE", path: path(id), auth: "secret", options }),
    rotate: async (id, options) => {
      const sent = withIdempotencyKey(options);
      const rotated = await call<NewWebhook>({
        method: "POST",
        path: `${path(id)}/rotate`,
        auth: "secret",
        options: sent,
      });
      return requireSecret(
        rotated,
        "secret",
        `Rotate ${rotated.id} again with a new Idempotency-Key.`,
        sent,
      );
    },
    test: async (id, options) =>
      call({ method: "POST", path: `${path(id)}/test`, auth: "secret", options }),
    deliveries,
  };
}
