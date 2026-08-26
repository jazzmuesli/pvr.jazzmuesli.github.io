// Wires the shared scenario store to either a language-model interpreter (which
// understands free-form requests and emits structured scenario changes via tool
// calling) or, as a fallback, the deterministic advisor. The class is small and
// injectable so it can be integration-tested with a fake interpreter (no network).

import { Store } from "../store";
import { Scenario, computeMetrics, appUrl } from "../scenario";
import { AdvisorOutput, AdvisorContext, advisorTurn, scenariosEqual, Stage } from "./advisor";
import { Logger } from "./logger";

export type GenerateFn = (system: string, out: AdvisorOutput) => Promise<string>;

export interface InterpretResult {
  reply: string;
  patch?: Partial<Scenario>;
}
export type InterpretFn = (ctx: {
  system: string;
  userMessage: string;
  scenario: Scenario;
}) => Promise<InterpretResult | null>;

export interface ChatBotOptions {
  store: Store<Scenario>;
  /** Primary interpreter (LLM tool-calling). Falls back to the advisor if omitted or throwing. */
  interpret?: InterpretFn;
  /** Legacy text-polish generator (used only when `interpret` is absent). */
  generate?: GenerateFn;
  systemPrompt?: string;
  logger?: Logger;
}

const VALID_PV = ["none", "balcony", "10", "20"] as const;
const VALID_BAT = ["off", "on"] as const;
const VALID_LOC = ["boizenburg", "hamburg", "berlin", "koeln", "muenchen"] as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Coerce an LLM-produced patch into a valid Scenario (drop anything invalid). */
export function coercePatch(base: Scenario, p: Partial<Scenario>): Scenario {
  const s: Scenario = { ...base };
  if (typeof p.consumptionKWh === "number" && Number.isFinite(p.consumptionKWh))
    s.consumptionKWh = clamp(Math.round(p.consumptionKWh), 500, 9000);
  if (typeof p.priceCt === "number" && Number.isFinite(p.priceCt))
    s.priceCt = clamp(Math.round(p.priceCt * 100) / 100, 5, 60);
  if (typeof p.location === "string" && (VALID_LOC as readonly string[]).includes(p.location))
    s.location = p.location;
  if (p.pv && (VALID_PV as readonly string[]).includes(p.pv)) s.pv = p.pv;
  if (p.battery && (VALID_BAT as readonly string[]).includes(p.battery)) s.battery = p.battery;
  if (typeof p.heatpump === "boolean") s.heatpump = p.heatpump;
  if (typeof p.heatpumpKWh === "number" && Number.isFinite(p.heatpumpKWh))
    s.heatpumpKWh = clamp(Math.round(p.heatpumpKWh), 2000, 5000);
  if (typeof p.ev === "boolean") s.ev = p.ev;
  if (typeof p.evKWh === "number" && Number.isFinite(p.evKWh))
    s.evKWh = clamp(Math.round(p.evKWh), 500, 6000);
  if (typeof p.bwwp === "boolean") s.bwwp = p.bwwp;
  return s;
}

export class ChatBot {
  private stage: Stage = "welcome";
  private store: Store<Scenario>;
  private interpret?: InterpretFn;
  private generate?: GenerateFn;
  private systemPrompt: string;
  private logger?: Logger;

  constructor(opts: ChatBotOptions) {
    this.store = opts.store;
    this.interpret = opts.interpret;
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
    const current = this.store.getState();
    let result: AdvisorOutput;

    if (this.interpret) {
      try {
        const r = await this.interpret({ system: this.systemPrompt, userMessage: message, scenario: current });
        if (r) {
          const changed = !!(r.patch && Object.keys(r.patch).length);
          const nextScenario = changed ? coercePatch(current, r.patch!) : current;
          const intent = changed ? "adjust" : message.trim() === "" ? "welcome" : "clarify";
          result = {
            reply: r.reply || (changed ? "Übernommen." : ""),
            intent,
            scenario: nextScenario,
            stage: "ready",
            metrics: computeMetrics(nextScenario),
            link: appUrl(nextScenario),
          };
        } else {
          result = await this.advisorFallback(message, current);
        }
      } catch {
        result = await this.advisorFallback(message, current);
      }
    } else {
      result = await this.advisorFallback(message, current);
    }

    this.stage = result.stage;
    if (!scenariosEqual(result.scenario, current)) {
      this.store.setState(result.scenario);
    }

    if (this.logger && message.trim() !== "") {
      this.logger.record({ role: "user", text: message, stage: this.stage });
    }

    if (this.logger) {
      this.logger.record({
        role: "bot",
        text: result.reply,
        intent: result.intent,
        stage: result.stage,
        scenario: result.scenario,
      });
    }
    return { ...result, reply: result.reply };
  }

  /** Deterministic fallback: the regex-based advisor (optionally polished by `generate`). */
  private async advisorFallback(message: string, current: Scenario): Promise<AdvisorOutput> {
    const ctx: AdvisorContext = { scenario: current, stage: this.stage };
    const out = advisorTurn(message, ctx);
    let reply = out.reply;
    if (this.generate) {
      try {
        reply = await this.generate(this.systemPrompt, out);
      } catch {
        reply = out.reply;
      }
    }
    return { ...out, reply, metrics: computeMetrics(out.scenario), link: appUrl(out.scenario) };
  }
}
