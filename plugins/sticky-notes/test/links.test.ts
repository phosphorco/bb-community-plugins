import assert from "node:assert/strict"
import test from "node:test"

import {
  citationTextForPaste,
  extractLinksFromPaste,
  insertPastedText,
  mergeNoteLinks,
  MAX_LINKS,
  nativeThreadIdForLinkActivation,
  noteLinkLabel,
  removeAndRenumberCitationMarkers,
} from "../links.ts"

const threadUrl = "https://bb.example.test/projects/proj_3ffg2ea7pb/threads/thr_2fgr888q86"

test("a pasted URL becomes a reference instead of remaining in the note body", () => {
  const extracted = extractLinksFromPaste(`Look at (1.)\n\n${threadUrl}`)
  assert.equal(extracted.text, "Look at (1.)\n\n")
  assert.deepEqual(extracted.links, [{
    url: threadUrl,
    domain: "bb.example.test",
    title: null,
  }])
})

test("pasted URL punctuation remains in the note body", () => {
  const extracted = extractLinksFromPaste(`See ${threadUrl}.`)
  assert.equal(extracted.text, "See.")
  assert.equal(extracted.links.length, 1)
})

test("an admitted URL is replaced with its numbered body citation", () => {
  const links = extractLinksFromPaste(threadUrl).links
  assert.equal(citationTextForPaste(`Look at ${threadUrl}`, links), "Look at (1.)")
})

test("removing a reference drops its marker and renumbers later markers", () => {
  assert.equal(
    removeAndRenumberCitationMarkers("Check (1.) then (2.) and (3.)", 2),
    "Check (1.) then  and (2.)",
  )
})

test("references retain their first-pasted order and ignore duplicates", () => {
  const first = extractLinksFromPaste(threadUrl).links[0]!
  const second = extractLinksFromPaste("https://example.com/article").links[0]!
  assert.deepEqual(mergeNoteLinks([first], [first, second]), [first, second])
})

test("overflow candidates stay available to the editor instead of being silently dropped", () => {
  const pasted = Array.from({ length: MAX_LINKS + 1 }, (_, index) => `https://example.com/${index}`).join(" ")
  assert.equal(extractLinksFromPaste(pasted).links.length, MAX_LINKS + 1)
})

test("same-host thread references use their title when it has resolved", () => {
  const link = { ...extractLinksFromPaste(threadUrl).links[0]!, title: "My cool thread" }
  assert.equal(noteLinkLabel(link, "bb.example.test"), "My cool thread")
})

test("a plain same-origin click on a thread reference uses BB navigation", () => {
  const activation = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
  assert.equal(nativeThreadIdForLinkActivation(threadUrl, "https://bb.example.test", activation), "thr_2fgr888q86")
  assert.equal(nativeThreadIdForLinkActivation(threadUrl, "https://bb.example.test", { ...activation, metaKey: true }), null)
})

test("pasted text respects the current selection", () => {
  assert.deepEqual(insertPastedText("before after", 7, 12, "next"), {
    text: "before next",
    caret: 11,
  })
})
