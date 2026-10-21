// Builds the Void app once before the tests, so `startWorker()` serves the
// same Worker that `void deploy` uploads.

import { createBuilder } from "vite"

export default async () => {
  // `vite build` builds every environment; `build()` alone only the client.
  const builder = await createBuilder({ logLevel: "warn" })
  await builder.buildApp()
}
