import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("compact plan narration reads saved routes in order and cancels on disconnect", async t => {
  const html = await readFile(new URL("../viewer/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../scripts/plan-narration.mjs", import.meta.url), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom, spoken = [];
  let cancelled = 0;
  window.speechSynthesis = { getVoices: () => [], speak: value => spoken.push(value), cancel: () => cancelled++ };
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  window.eval(source);
  const panel = window.document.getElementById("swarm-plan-details");
  const connection = window.document.getElementById("conn");
  panel.hidden = true;
  panel.dataset.routes = JSON.stringify([
    { name: "Box A", bin: "left" }, { name: "Box B", bin: "right" }, { name: "Box C", bin: "left" },
  ]);
  connection.classList.add("on");
  await Promise.resolve();
  const button = [...window.document.querySelectorAll(".demo-controls button")].find(b => b.textContent === "Say it");
  assert.ok(button, "voice control stays visible outside the hidden details panel");
  button.click();
  assert.equal(spoken.length, 1);
  assert.match(spoken[0].text, /Box A to the left bin\. Box B to the right bin\. Box C to the left bin\./);
  assert.equal(button.textContent, "Stop speaking");
  connection.classList.remove("on");
  await Promise.resolve();
  assert.equal(cancelled, 1);
  assert.equal(button.isConnected, false);
  connection.classList.add("on"); panel.dataset.routes = "[]";
  await Promise.resolve();
  assert.equal(button.isConnected, false, "no voice control for an invalidated plan");
});
