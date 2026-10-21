// GET /: the overview, every tool by category.

import { defineHandler } from "void"
import { homePage } from "../src/app/handler.ts"
import { tools } from "../src/tools/index.ts"

export const GET = defineHandler(() => homePage(tools))
