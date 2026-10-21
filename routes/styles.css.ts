// GET /styles.css: the stylesheet, cached for a year; its URL carries a hash.

import { defineHandler } from "void"
import { stylesheet } from "../src/app/handler.ts"

export const GET = defineHandler(() => stylesheet())
