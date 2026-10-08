import { describe, expectTypeOf, it } from "vitest";

import {
  isConnectionError,
  type ApiErrorCode,
  type ErrorCode,
  type Launch,
  type LaunchPrepareParams,
  type RelayForSI,
  type RelayForSIError,
  type ImageStreamEvent,
  type Token,
} from "../../src";
import type { components } from "../../src/generated/schema";
import type { WebhookEventSchemas } from "../../src/generated/spec";
import type { RelayForSIEvent } from "../../src/webhooks";

type Schemas = components["schemas"];

declare const relayForSI: RelayForSI;

describe("public types", () => {
  it("narrow webhook events by type", () => {
    const handle = (event: RelayForSIEvent): string => {
      switch (event.type) {
        case "launch.confirmed":
          expectTypeOf(event.data.launch).toEqualTypeOf<Launch>();
          return event.data.launch.mint;
        case "payout.credited":
          expectTypeOf(event.data.payout.ai_lamports).toEqualTypeOf<string>();
          return event.data.payout.signature;
        default:
          return event.type;
      }
    };
    expectTypeOf(handle).returns.toEqualTypeOf<string>();
  });

  it("cover every webhook event in the spec, and only those", () => {
    type FromSpec = Schemas[WebhookEventSchemas[keyof WebhookEventSchemas]];
    expectTypeOf<RelayForSIEvent["type"]>().toEqualTypeOf<keyof WebhookEventSchemas>();
    expectTypeOf<RelayForSIEvent>().toExtend<FromSpec>();
    expectTypeOf<FromSpec>().toExtend<RelayForSIEvent>();
  });

  it("type token events with the token", () => {
    const handle = (event: RelayForSIEvent): string | undefined =>
      event.type === "token.graduated" || event.type === "route.changed"
        ? event.data.token.mint
        : undefined;
    expectTypeOf(handle).returns.toEqualTypeOf<string | undefined>();
  });

  it("accept known and unknown error codes", () => {
    expectTypeOf<"insufficient_funds">().toExtend<ErrorCode>();
    expectTypeOf<"method_not_allowed">().toExtend<ApiErrorCode>();
    expectTypeOf<"insufficient_balance">().toExtend<ErrorCode>();
    expectTypeOf<"wait_timeout">().toExtend<ErrorCode>();
    expectTypeOf<"a_code_from_next_year">().toExtend<ErrorCode>();
  });

  it("keep the else branch of a guard typed", (error: RelayForSIError) => {
    if (isConnectionError(error)) return;
    expectTypeOf(error.code).toEqualTypeOf<ErrorCode>();
  });

  it("accept bigint amounts and undefined optionals", () => {
    expectTypeOf<{
      creator: string;
      name: string;
      symbol: string;
      image: string;
      opening_buy_lamports: bigint;
      description: undefined;
    }>().toExtend<LaunchPrepareParams>();
  });

  it("yield items from all()", () => {
    expectTypeOf(relayForSI.launches.all()).toExtend<AsyncIterable<Launch>>();
    expectTypeOf(relayForSI.tokens.all()).toExtend<AsyncIterable<Token>>();
  });

  it("stream image events", async () => {
    const events = await relayForSI.ai.images.stream({ model: "m", prompt: "p" });
    expectTypeOf(events).toExtend<AsyncIterable<ImageStreamEvent>>();
  });

  it("type keys.create's key as a string", async () => {
    const created = await relayForSI.keys.create({ account: "acc_1", name: "agent" });
    expectTypeOf(created.key).toEqualTypeOf<string>();
  });
});
