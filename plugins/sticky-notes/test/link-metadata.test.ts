import assert from "node:assert/strict"
import test from "node:test"

import { titleFromHtml } from "../link-metadata.ts"

test("Open Graph and Twitter titles take precedence over the document title", () => {
  assert.equal(titleFromHtml(`
    <html><head>
      <title>Document title</title>
      <meta content="OG &amp; title" property="og:title">
    </head></html>
  `), "OG & title")
})

test("document titles are normalized and bounded", () => {
  assert.equal(titleFromHtml("<title>  A\n useful   page  </title>"), "A useful page")
  assert.equal(titleFromHtml("<main>No title</main>"), null)
})
