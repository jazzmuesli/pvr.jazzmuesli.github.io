// Wires the pure advisor to the shared scenario store and (optionally) a
// language-model generator. The class is intentionally small and injectable so
// it can be integration-tested with a fake generator (no network needed).

import { Store } from "../store";
import { Scenario } from "../scenario";
import { AdvisorOutput, AdvisorContext, advisorTurn, scenariosEqual, Stage } from "./advisor";
import { Logger } from "./logger";

export type GenerateFn = (system: string, out: AdvisorOutput) => Promise<string>;

export interface ChatBotOptions {
  store: Store<Scenario>;
  generate?: GenerateFn;
  systemPrompt?: string;
  logger?: Logger;
}

export class ChatBot {
  private stage: Stage = "welcome";
  private store: Store<Scenario>;
  private generate?: GenerateFn;
  private systemPrompt: string;
  private logger?: Logger;

  constructor(opts: ChatBotOptions) {
    this.store = opts.store;
    this.generate = opts.generate;
    this.systemPrompt = opts.systemPrompt ?? "Du bist ein Energiewende-Berater.";
    this.logger = opts.logger;
  }

  reset(): void {
    this.stage = "welcome";
  }

  getStage(): Stage {
    return this.stage;
  }

  async send(message: string): Promise<AdvisorOutput & { reply: string }> {
    const ctx: AdvisorContext = { scenario: this.store.getState(), stage: this.stage };
    const out = advisorTurn(message, ctx);
    this.stage = out.stage;

    if (!scenariosEqual(out.scenario, this.store.getState())) {
      this.store.setState(out.scenario);
    }

    if (this.logger && message.trim() !== "") {
      this.logger.record({ role: "user", text: message, stage: this.stage });
    }

    let reply = out.reply;
    if (this.generate) {
      try {
        reply = await this.generate(this.systemPrompt, out);
      } catch {
        reply = out.reply; // fall back to the template if the LLM is unavailable
      }
    }

    if (this.logger) {
      this.logger.record({
        role: "bot",
        text: reply,
        intent: out.intent,
        stage: out.stage,
        scenario: out.scenario,
      });
    }
    return { ...out, reply };
  }
}
