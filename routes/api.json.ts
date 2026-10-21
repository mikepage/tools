// GET /api.json: every tool with its parameters. The CLI reads it.

import { defineHandler } from "void"
import { catalog } from "../src/app/handler.ts"
import { tools } from "../src/tools/index.ts"

export const GET = defineHandler(() => catalog(tools))
