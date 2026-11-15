// Read the validated routes already shown by the viewer. The planner and its
// WebSocket protocol stay independent of speech.
const panel = document.getElementById("swarm-plan-details");
const controls = document.querySelector(".plan-actions");
const connection = document.getElementById("conn");
const speech = window.speechSynthesis;
if (panel && controls && connection && speech && typeof SpeechSynthesisUtterance === "function") {
  installNarration();
}

function installNarration() {
  const button = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: "Say it",
    title: "Read the validated sort plan aloud",
  });
  let active;
  let currentPlan;

  function narration() {
    if (!connection.classList.contains("on")) return null;
    let steps;
    try { steps = JSON.parse(panel.dataset.routes ?? "[]"); } catch { return null; }
    if (!Array.isArray(steps)) return null;
    const routes = steps.map(step => typeof step?.name === "string" && ["left", "right"].includes(step.bin)
      ? `${step.name} to the ${step.bin} bin.` : null);
    return routes.length && routes.every(Boolean)
      ? `See it. Say it. Sort it. The simulation predicts this order. ${routes.join(" ")}`
      : null;
  }

  function stop() {
    if (!active) return;
    active = undefined;
    speech.cancel();
    button.textContent = "Say it";
  }

  function update() {
    const next = narration();
    if (next !== currentPlan) {
      stop();
      currentPlan = next;
      button.textContent = "Say it";
    }
    if (!next) button.remove();
    else if (!controls.contains(button)) controls.prepend(button);
  }

  button.onclick = () => {
    if (active) return stop();
    const text = narration();
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = speech.getVoices().filter(voice => voice.localService && /^en\b/i.test(voice.lang));
    const localVoice = voices.find(voice => voice.lang.toLowerCase() === "en-gb") ?? voices[0];
    if (localVoice) utterance.voice = localVoice;
    utterance.lang = localVoice?.lang ?? "en-GB";
    utterance.rate = 0.95;
    utterance.onend = utterance.onerror = event => {
      if (active !== utterance) return;
      active = undefined;
      button.textContent = event.type === "error" ? "Retry voice" : "Say it";
    };
    active = utterance;
    button.textContent = "Stop speaking";
    speech.speak(utterance);
  };

  const observer = new MutationObserver(update);
  observer.observe(panel, { attributes: true, attributeFilter: ["data-routes"] });
  observer.observe(connection, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("pagehide", stop);
  speech.getVoices(); // Allow browsers with asynchronous voice loading to prime the list.
  update();
}
