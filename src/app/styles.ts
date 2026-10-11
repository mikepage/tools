// The whole stylesheet. Black, white and one blue, in light and dark.

export const css = String.raw`
:root {
  color-scheme: light dark;
  --bg: light-dark(#fff, #0d0d0f);
  --surface: light-dark(#f6f7f9, #17181b);
  --text: light-dark(#111, #ededed);
  --muted: light-dark(#5f6368, #9aa0a6);
  --border: light-dark(#e3e5e8, #2a2c30);
  --brand: light-dark(#0066cc, #4da3ff);
  --on-brand: light-dark(#fff, #0d0d0f);
  --ok: light-dark(#13795b, #4cc38a);
  --warn: light-dark(#a35200, #f0a04b);
  --bad: light-dark(#c5221f, #ff7b72);
  --mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
  --sans: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 var(--sans); }
a { color: var(--brand); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: var(--mono); font-size: .875em; }
.wrap { max-width: 880px; margin: 0 auto; padding: 0 16px; }

header.site { border-bottom: 1px solid var(--border); }
header.site .wrap { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding-block: 14px; }
header.site .brand { color: var(--text); font-weight: 700; letter-spacing: -.01em; }
header.site nav { display: flex; gap: 16px; font-size: 14px; }
header.site nav a { color: var(--muted); }

main { padding-block: 32px 64px; }
h1 { font-size: 28px; line-height: 1.2; letter-spacing: -.02em; margin: 0 0 6px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 32px 0 10px; font-weight: 600; }
h3 { font-size: 15px; margin: 20px 0 8px; }
.lede { color: var(--muted); margin: 0 0 24px; max-width: 60ch; }
.eyebrow { font-size: 13px; color: var(--muted); margin-bottom: 4px; }

/* Overview */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.grid a { display: block; padding: 14px 16px; background: var(--bg); color: var(--text); }
.grid a:hover { background: var(--surface); text-decoration: none; }
.grid strong { display: block; font-weight: 600; }
.grid span { color: var(--muted); font-size: 14px; }

/* Form */
form.tool { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; padding: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field.grow { flex: 1 1 260px; }
.field label { font-size: 12px; font-weight: 600; color: var(--muted); }
input[type=text], input[type=search], input[type=number], select, textarea {
  font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; min-width: 0;
}
textarea { font-family: var(--mono); font-size: 13px; width: 100%; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--brand); outline-offset: -1px; border-color: transparent; }
.check { display: flex; align-items: center; gap: 6px; font-size: 14px; padding-bottom: 9px; }
button { font: inherit; font-weight: 600; color: var(--on-brand); background: var(--brand); border: 0; border-radius: 7px; padding: 9px 18px; cursor: pointer; }
.examples { margin: 10px 0 0; font-size: 14px; color: var(--muted); }
.examples a { margin-right: 12px; }

/* Results */
.result { margin-top: 28px; }
.notice { margin-top: 20px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); }
.notice.bad { border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.notice strong { color: var(--bad); }
.summary { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0 0 16px; font-size: 14px; color: var(--muted); }
.summary b { color: var(--text); font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--border); }
th { font-size: 12px; font-weight: 600; color: var(--muted); }
td.mono, td code { word-break: break-all; }
dl.kv { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 20px; margin: 0; font-size: 14px; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; word-break: break-word; }
.break { word-break: break-all; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .muted { color: var(--muted); }
.status::before { display: inline-block; width: 1.2em; font-weight: 700; }
.status.ok::before { content: "✓"; } .status.warn::before { content: "!"; } .status.bad::before { content: "✕"; }
pre.block { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
ul.tree { list-style: none; padding-left: 0; margin: 4px 0; }
ul.tree ul.tree { padding-left: 1.1em; border-left: 1px solid var(--border); }
ul.tree li { padding: 3px 0; }
ul.plain { list-style: none; padding: 0; margin: 0; }
ul.plain li { padding: 6px 0; border-bottom: 1px solid var(--border); }

/* Machine access */
.api { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
.api code { color: var(--text); }

footer.site { border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
footer.site .wrap { padding-block: 20px; }

@media (max-width: 560px) {
  h1 { font-size: 24px; }
  form.tool { flex-direction: column; align-items: stretch; }
  .field.grow { flex: none; }
  dl.kv { grid-template-columns: 1fr; gap: 2px; }
  dl.kv dd { margin-bottom: 8px; }
}
`

// A short content hash for the stylesheet URL, so a deploy never serves a stale cache.
const fnv1a = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}
export const cssHref = `/styles.css?v=${fnv1a(css)}`
