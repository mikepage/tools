import { defineConfig } from "vite"
import { voidPlugin } from "void"

export default defineConfig({
  plugins: [voidPlugin()],
  build: { minify: true },
  // The views use this package's own JSX runtime, which renders HTML strings.
  oxc: { jsx: { runtime: "automatic", importSource: "@mikepage/tools" } },
})