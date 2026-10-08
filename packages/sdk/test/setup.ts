import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./helpers";

// Unhandled requests fail the test.
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
