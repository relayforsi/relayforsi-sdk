// Webhook payloads, named over the schemas of the spec's `webhooks` section. The union below
// must cover every event the spec lists: a type test fails when the API adds one.
import type { components } from "../generated/schema";

type Schemas = components["schemas"];
// Interfaces can only extend a named type, not an indexed access type.
type Schema<K extends keyof Schemas> = Schemas[K];

/** A launch the chain confirmed: its token is on its route. `data.launch` */
export interface LaunchConfirmedEvent extends Schema<"LaunchConfirmedEvent"> {}
/**
 * A launch or import the chain refused, or whose route came out other than prepared.
 * `data.launch.error` says why.
 */
export interface LaunchFailedEvent extends Schema<"LaunchFailedEvent"> {}
/** An import the chain confirmed: the existing token is on its route. `data.launch` */
export interface TokenImportedEvent extends Schema<"TokenImportedEvent"> {}
/** A token's curve completed: it trades on PumpSwap, its fees still on its route. */
export interface TokenGraduatedEvent extends Schema<"TokenGraduatedEvent"> {}
/** A payout of a token's creator fees became AI credit. `data.payout` */
export interface PayoutCreditedEvent extends Schema<"PayoutCreditedEvent"> {}
/** An account's spendable credit fell under the threshold: once, until a credit lifts it back. */
export interface AccountLowBalanceEvent extends Schema<"AccountLowBalanceEvent"> {}
/** A router key's call was refused for its spending limit: once in each of the limit's periods. */
export interface KeyLimitReachedEvent extends Schema<"KeyLimitReachedEvent"> {}
/**
 * A token's creator fees no longer follow the route relayfor.si locked (a takeover on
 * pump.fun): its payouts stop.
 */
export interface RouteChangedEvent extends Schema<"RouteChangedEvent"> {}
/** Sent by `webhooks.test()` only. */
export interface PingEvent extends Schema<"PingEvent"> {}

/**
 * Any webhook event. Switch on `type` to narrow `data`, and keep a `default:` branch for event
 * types added after this SDK version. Deliveries are at least once: deduplicate on `id`.
 */
export type RelayForSIEvent =
  | LaunchConfirmedEvent
  | LaunchFailedEvent
  | TokenImportedEvent
  | TokenGraduatedEvent
  | PayoutCreditedEvent
  | AccountLowBalanceEvent
  | KeyLimitReachedEvent
  | RouteChangedEvent
  | PingEvent;

export type RelayForSIEventType = RelayForSIEvent["type"];
