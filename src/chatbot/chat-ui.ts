// Chat panel UI: renders the message log and input, drives the ChatBot, and
// keeps the shared scenario store in sync (the advisor can change the scenario,
// which the wizard reflects automatically).

import { Store } from "../store";
import { Scenario } from "../scenario";
import { ChatBot, GenerateFn } from "./chatbot";
import { createLogger } from "./logger";

export interface ChatUiOptions {
  mount: HTMLElement;
  store: Store<Scenario>;
  generate?: GenerateFn;
  systemPrompt?: string;
}

export function initChat(opts: ChatUiOptions): ChatBot {
  const logger = createLogger();
  const bot = new ChatBot({ store: opts.store, generate: opts.generate, systemPrompt: opts.systemPrompt, logger });

  opts.mount.innerHTML = `
    <div class="chat-log" id="chat-log"></div>
    <div class="chat-input-row">
      <input type="text" id="chat-input" class="chat-input" placeholder="Frag mich zur Energiewende …" />
      <button id="chat-send" class="pill">Senden</button>
    </div>`;
  const log = opts.mount.querySelector("#chat-log") as HTMLElement;
  const input = opts.mount.querySelector("#chat-input") as HTMLInputElement;
  const sendBtn = opts.mount.querySelector("#chat-send") as HTMLButtonElement;

  function addBubble(who: "user" | "bot", text: string): HTMLElement {
    const b = document.createElement("div");
    b.className = `chat-bubble chat-${who}`;
    b.textContent = text;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  async function send(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    input.value = "";
    addBubble("user", message);
    const loading = addBubble("bot", "…");
    try {
      const out = await bot.send(message);
      loading.textContent = out.reply;
    } catch {
      loading.textContent = "Entschuldigung, etwas ist schiefgelaufen.";
    }
    log.scrollTop = log.scrollHeight;
  }

  sendBtn.addEventListener("click", () => send(input.value));
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") send(input.value);
  });

  // Greet the user immediately.
  (async () => {
    const out = await bot.send("");
    addBubble("bot", out.reply);
  })();

  return bot;
}
