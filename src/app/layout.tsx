import { type Child, type Html, raw } from "../jsx/jsx-runtime.ts"
import { cssHref } from "./styles.ts"

export const Layout = (props: {
  readonly title: string
  readonly description: string
  readonly children?: Child
}): Html =>
  raw(
    "<!doctype html>" +
      (
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>{props.title}</title>
            <meta name="description" content={props.description} />
            <link rel="stylesheet" href={cssHref} />
            <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%230066cc'/%3E%3C/svg%3E" />
          </head>
          <body>
            <header class="site">
              <div class="wrap">
                <a class="brand" href="/">tools</a>
                <nav>
                  <a href="https://github.com/mikepage/tools">Source</a>
                  <a href="https://mikepage.nl">mikepage.nl</a>
                </nav>
              </div>
            </header>
            <main class="wrap">{props.children}</main>
            <footer class="site">
              <div class="wrap">
                Void on Cloudflare Workers. The web platform, no <code>nodejs_compat</code>.
              </div>
            </footer>
          </body>
        </html>
      ).value,
  )
