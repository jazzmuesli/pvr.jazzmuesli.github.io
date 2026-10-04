// Numeric control: a native <input type="number"> that keeps the browser's own
// up/down stepper (arrow buttons + arrow-key repeat) instead of a range slider.
//
// Typing is deliberately unrestricted so intermediate states ("1", "12", "125")
// are not rewritten mid-keystroke; the model only ever receives a value clamped
// to [min, max], so out-of-range text can never reach the simulation. Values
// coming from the outside (URL, advisor, preset) are displayed snapped to the
// step, which also keeps floating-point noise out of the field.

export interface NumberFieldSpec {
  id?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  onInput: (value: number) => void;
}

export interface NumberField {
  /** `.num-wrap` holding the input plus its unit suffix. */
  wrap: HTMLElement;
  input: HTMLInputElement;
  /** Write a value in from the outside (URL, advisor, preset). */
  setValue: (v: number) => void;
}

function decimalsOf(step: number): number {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

export function numberField(spec: NumberFieldSpec): NumberField {
  const { min, max, step, unit } = spec;
  const decimals = decimalsOf(step);
  const clamp = (v: number): number => Math.min(max, Math.max(min, v));
  const snap = (v: number): number => {
    const stepped = min + Math.round((clamp(v) - min) / step) * step;
    return Number(clamp(stepped).toFixed(decimals));
  };

  const wrap = document.createElement("div");
  wrap.className = "num-wrap";

  const input = document.createElement("input");
  input.type = "number";
  if (spec.id) input.id = spec.id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);

  /** Last value the model knows — restored when the field is left empty. */
  let last = snap(spec.value);
  input.value = String(last);

  const setValue = (v: number): void => {
    // Never overwrite what the user is currently typing.
    if (document.activeElement === input) return;
    last = snap(v);
    input.value = String(last);
    wrap.classList.remove("invalid");
  };

  input.addEventListener("input", () => {
    const v = input.valueAsNumber;
    if (!Number.isFinite(v)) {
      wrap.classList.add("invalid");
      return;
    }
    wrap.classList.remove("invalid");
    last = clamp(v);
    spec.onInput(last);
  });

  /** Leaving the field: drop a leftover "-"/"" and pull out-of-range text back. */
  const normalise = (): void => {
    wrap.classList.remove("invalid");
    const v = input.valueAsNumber;
    if (!Number.isFinite(v)) {
      input.value = String(last);
      return;
    }
    if (v !== clamp(v)) {
      input.value = String(clamp(v));
      last = clamp(v);
      spec.onInput(last);
    }
  };

  input.addEventListener("change", normalise);
  input.addEventListener("blur", normalise);
  input.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === "Enter") normalise();
    // A number input silently drops a decimal comma, so "24,7" would become
    // "247". Insert the dot through the editing engine instead — a plain value
    // assignment is rejected while the number is still incomplete ("24.").
    else if (ev.key === "," && decimals > 0) {
      ev.preventDefault();
      document.execCommand("insertText", false, ".");
    }
  });
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!text.includes(",")) return;
    e.preventDefault();
    document.execCommand("insertText", false, text.replace(",", "."));
  });

  wrap.appendChild(input);
  if (unit) {
    const u = document.createElement("span");
    u.className = "unit";
    u.textContent = unit;
    wrap.appendChild(u);
  }

  return { wrap, input, setValue };
}