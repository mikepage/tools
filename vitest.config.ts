// Tests run in Node and start Workers in workerd. This config keeps
// voidPlugin() out of the test process; test/build.ts builds the app first.

import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { globalSetup: ["test/build.ts"] },
})
