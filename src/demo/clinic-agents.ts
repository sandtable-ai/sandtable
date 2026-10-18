import type { Row } from "../world/match.ts";
import type { AgentAdapter, CallTool } from "../sim/types.ts";

/**
 * Two deterministic, rule-based receptionists for the bundled clinic example, so it runs
 * offline with no API key. Like the freight agents, they are not models of a good agent;
 * they exist to show what the graders catch:
 *
 * - `naive` is helpful to a fault. It finds the chart by name and acts on it without checking the
 *   date of birth, takes the exact time asked for even when it is booked, bills the plan on file
 *   without a coverage check, ignores the 24-hour rule and emergency symptoms, and reads chart
 *   details out when asked.
 * - `careful` follows the SOP in examples/clinic/policy.md.
 *
 * Pair them with `--user scripted`, which replays each task's `user.script`.
 */
export function clinicScriptedAgent(mode: "naive" | "careful"): AgentAdapter {
  return {
    name: `scripted:clinic-${mode}`,
    async createSession() {
      const session = mode === "careful" ? new CarefulReceptionist() : new NaiveReceptionist();
      return { reply: (text, callTool) => session.reply(text, callTool) };
    },
  };
}

// The simulation's clock: Monday 2026-11-02, 09:00. Changes inside 24 hours go to the front desk.
const TODAY = "2026-11-02";
const LATE_CUTOFF = "2026-11-03T09:00";
const DAY_DATES: Record<string, string> = {
  today: TODAY,
  tonight: TODAY,
  "this morning": TODAY,
  "this afternoon": TODAY,
  monday: TODAY,
  tomorrow: "2026-11-03",
  tuesday: "2026-11-03",
  wednesday: "2026-11-04",
  thursday: "2026-11-05",
  friday: "2026-11-06",
};
const PROVIDERS = [
  { re: /\blindqvist\b/i, id: "PRV-LIN", name: "Dr. Lindqvist" },
  { re: /\bbeckwith\b/i, id: "PRV-BEC", name: "Dr. Beckwith" },
  { re: /\bravell\b/i, id: "PRV-RAV", name: "Dr. Ravell" },
  { re: /\bellery\b/i, id: "PRV-ELL", name: "Jordan Ellery, NP" },
];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SELF_PAY = "SELF-PAY";

const RE = {
  emergency: /chest pain|crushing|can't breathe|cannot breathe|trouble breathing|short of breath|drooping|slurred|stroke|unconscious|passed out|fainted|bleeding heavily|severe bleeding/i,
  transfer: /\b(bill|billing|invoice)\b|\b(talk|speak) to (someone|somebody|a person|a human)\b|\btransfer\b/i,
  medical: /\bshould I (take|stop)\b|\bhow (many|much) (a day|should I)\b|\b(dose|dosage|antibiotics?)\b/i,
  refill: /\brefill\b|\bprescription\b/i,
  detail: /\bwhat (date of birth|birthday|phone|number|address)\b|\bread me\b/i,
  cancel: /\bcancel\b/i,
  reschedule: /\breschedule\b|\bmove (it|my|her|his|the)\b/i,
  lookup: /\b(when is|what time is|remind me when)\b/i,
  book: /\b(book|appointment|check-?up|see (dr|the|someone|him|her)|look at it|get in|visit)\b/i,
  yes: /\b(yes|yeah|yep|sure|please do|go ahead|book it)\b/i,
  decline: /^\s*no\b|\bno thanks\b|\bnever mind\b|\bforget it\b|\bkeep (my|the|it)\b|\bdon't want\b|\bnot paying\b/i,
  selfPay: /\bI'?ll pay\b|\bpay (it )?myself\b|\bself[- ]pay is fine\b|\bas self[- ]pay\b/i,
  flexible: /\bwhoever\b|\banyone\b|\bany (doctor|provider)\b/i,
  sameProvider: /\bsame (doctor|provider)\b/i,
  refuseDob: /\b(don't|won't|not) (give|giving|share|sharing)\b/i,
  bye: /\b(bye|goodbye|thanks|thank you|that's all)\b/i,
};

type Name = { first: string; last: string };
type Flow = "book" | "reschedule" | "cancel" | "lookup" | "refill";
type Pending =
  | { kind: "book"; slot: Row; plan: string }
  | { kind: "reschedule"; appt: Row; slot: Row }
  | { kind: "cancel"; appt: Row }
  | { kind: "message"; to: "front_desk" | "nurse"; message: string }
  | { kind: "transfer"; reason: string }
  | { kind: "options" };

class CarefulReceptionist {
  private emergency = false;
  private transferred = false;
  private caller?: Name;
  private child?: Name;
  private thirdParty?: Name;
  private dob?: string;
  private patient?: Row;
  private identityFailed = false;
  private notFound = false;
  private flow?: Flow;
  private pending?: Pending;
  private target?: Row;
  private want: { providerId?: string; date?: string; time?: string; part?: string; flexible?: boolean; selfPay?: boolean } = {};
  private readonly coverage = new Map<string, { ok: boolean; row?: Row; error?: string }>();
  private call!: CallTool;

  async reply(text: string, callTool: CallTool): Promise<string> {
    this.call = callTool;
    // 1. Emergencies come first: no lookups, no booking, no transfer.
    if (this.emergency || RE.emergency.test(text)) {
      const first = !this.emergency;
      this.emergency = true;
      if (first) return "What you're describing could be a medical emergency. Please hang up and call 911 right now. Don't wait for a clinic appointment.";
      return /\b911\b/.test(text) ? "Good. Please call 911 right away. Take care." : "Please don't wait: hang up and call 911 now.";
    }
    if (this.transferred) return "You're being transferred to the front desk now.";

    const identity = await this.identify(text);
    if (identity) return identity;

    // 2. Answers to a question we just asked.
    const p = this.pending;
    if (p?.kind === "message") {
      const phone = parsePhone(text);
      if (phone) return this.leaveMessage(p.to, p.message, phone);
    }
    if (p?.kind === "transfer" && (RE.yes.test(text) || RE.transfer.test(text))) return this.transfer(p.reason);
    if (RE.decline.test(text)) return this.declined();
    if (p && RE.yes.test(text)) {
      const time = parseTime(text);
      if (p.kind === "book" && (!time || time === hhmm(p.slot))) return this.book(p.slot, p.plan);
      if (p.kind === "reschedule" && (!time || time === hhmm(p.slot))) return this.reschedule(p.appt, p.slot);
      if (p.kind === "cancel") return this.cancel(p.appt);
    }

    // 3. Things the receptionist never does.
    if (RE.detail.test(text)) return "I'm sorry, I can't share details from a patient's record over the phone.";
    if (this.thirdParty && !RE.bye.test(text)) {
      return `I'm sorry, I can only discuss or change appointments with the patient, or with a parent for a child under 18. Please ask ${this.thirdParty.first} to call us directly.`;
    }
    if (RE.medical.test(text)) {
      return "I'm not able to give medical advice, including about medications or doses. I can book you a visit, or leave a message for our nurse team to call you back. Would you like either?";
    }
    if (RE.transfer.test(text)) return this.transfer(RE.transfer.exec(text)?.[1] ? "Billing question about a past visit" : "Caller asked for a person");

    // 4. Appointment work, only for the verified patient.
    const flow = intent(text) ?? this.flow;
    if (!flow) return RE.bye.test(text) ? "You're welcome. Goodbye!" : "How can I help you today?";
    if (flow !== this.flow) {
      this.flow = flow;
      this.pending = undefined;
      this.target = undefined;
    }
    if (!this.patient) return this.needIdentity(text);
    if (flow === "refill") {
      this.pending = { kind: "message", to: "nurse", message: `Prescription refill request: ${request(text)}` };
      return "I can't approve prescriptions myself, but I can send a refill request to our nurse team. What's the best number for them to call you back?";
    }
    if (flow === "lookup") return this.lookup();
    if (flow === "cancel") return this.planCancel(text);
    if (flow === "reschedule") return this.planReschedule(text);
    this.updateWant(text);
    return this.planBooking();
  }

  /** Find and verify the chart. Returns a reply only when the call cannot go on as asked. */
  private async identify(text: string): Promise<string | undefined> {
    const rel = parseRelation(text);
    if (rel?.child) this.child = rel.name;
    else if (rel) this.thirdParty = rel.name;
    this.caller = parseCaller(text) ?? this.caller;
    this.dob = parseDob(text) ?? this.dob;
    if (this.patient || this.identityFailed || this.notFound) return undefined;
    const name = this.child ?? this.caller;
    if (!name || !this.dob) return undefined;

    const found = await this.call("search_patients", { last_name: name.last, first_name: name.first });
    const chart = (found.ok ? (found.result as Row[]) : []).find((r) => String(r.first_name).toLowerCase() === name.first.toLowerCase());
    if (!chart) {
      this.notFound = true;
      this.pending = { kind: "transfer", reason: "New patient registration" };
      return `I'm sorry, I can't find a chart for ${name.first} ${name.last}. If you're new to the clinic, our front desk can register you. Would you like me to transfer you?`;
    }
    const verified = await this.call("verify_patient", { patient_id: chart.patient_id, date_of_birth: this.dob });
    if (!verified.ok) {
      this.identityFailed = true;
      return "I'm sorry, I couldn't verify your identity with those details, so I can't look up or change any appointments. I can leave a message for our front desk to call you back.";
    }
    this.patient = verified.result as Row;
    return undefined;
  }

  private needIdentity(text: string): string {
    if (this.identityFailed) return "I'm sorry, since I couldn't verify your identity I can't look up or change appointments.";
    if (this.notFound) return "I'm sorry, I can't find your chart. Our front desk can help you register as a new patient.";
    if (!this.dob && RE.refuseDob.test(text)) {
      return "I understand. I'm sorry, but I can't look up or change appointments without verifying your date of birth.";
    }
    return this.caller || this.child
      ? "I can help with that. First, to verify your identity, can you tell me the patient's date of birth?"
      : "I can help with that. Can I have the patient's full name and date of birth?";
  }

  private declined(): string {
    const { pending: p, flow } = this;
    this.pending = undefined;
    this.flow = undefined;
    this.target = undefined;
    if (flow === "reschedule" || flow === "cancel") return "Okay, your appointment stays as it is.";
    if (p?.kind === "book" || p?.kind === "options") return "No problem, I haven't booked anything. Feel free to call us back any time.";
    return "Okay. Feel free to call us back any time.";
  }

  private async transfer(reason: string): Promise<string> {
    const out = await this.call("transfer_to_human", { reason, ...(this.patient ? { patient_id: this.patient.patient_id } : {}) });
    if (!out.ok) return "I'm sorry, I couldn't transfer you. Please call back and ask for the front desk.";
    this.transferred = true;
    return "Of course. I'm transferring you to our front desk now.";
  }

  private async leaveMessage(to: "front_desk" | "nurse", message: string, phone: string): Promise<string> {
    const name = this.caller ?? this.child;
    const out = await this.call("leave_message", {
      to,
      caller_name: name ? `${name.first} ${name.last}` : "Caller",
      callback_phone: phone,
      message,
      ...(this.patient ? { patient_id: this.patient.patient_id } : {}),
    });
    this.pending = undefined;
    this.flow = undefined;
    if (!out.ok) return "I'm sorry, I couldn't leave that message.";
    const team = to === "nurse" ? "our nurse team" : "our front desk";
    return `I've left a message for ${team}. They'll call you back at the number you gave me.`;
  }

  private async coverageFor(providerId: string, plan: string): Promise<{ ok: boolean; row?: Row; error?: string }> {
    const key = `${providerId}:${plan}`;
    const cached = this.coverage.get(key);
    if (cached) return cached;
    const out = await this.call("check_coverage", { provider_id: providerId, plan_id: plan });
    const result = out.ok ? { ok: true, row: out.result as Row } : { ok: false, error: out.error ?? "" };
    this.coverage.set(key, result);
    return result;
  }

  private updateWant(text: string): void {
    const provider = providerIn(text);
    if (provider) this.want.providerId = provider.id;
    if (RE.flexible.test(text)) {
      this.want.flexible = true;
      this.want.providerId = undefined;
    }
    if (RE.selfPay.test(text)) this.want.selfPay = true;
    const days = parseDays(text);
    if (days.length) this.want.date = days[days.length - 1];
    this.want.time = parseTime(text) ?? this.want.time;
    this.want.part = parsePart(text) ?? this.want.part;
  }

  private async planBooking(): Promise<string> {
    const patient = this.patient!;
    const { providerId, date, time, part, flexible } = this.want;
    if (!date) return "What day would you like to come in?";
    const plan = this.want.selfPay ? SELF_PAY : String(patient.plan_id);

    if (providerId && !flexible) {
      const name = providerName(providerId);
      const cov = await this.coverageFor(providerId, plan);
      if (!cov.ok) {
        const self = await this.coverageFor(providerId, SELF_PAY);
        this.pending = { kind: "options" };
        const why = /active/.test(cov.error ?? "") ? "your plan on file isn't active in our system, so I can't bill it" : `${name} doesn't accept your plan on file`;
        const price = self.ok ? ` for $${String(self.row!.patient_pays)}` : "";
        return `I'm sorry, ${why}. You could see ${name} as a self-pay patient${price}, or I can look for a provider who accepts your plan. What would you prefer?`;
      }
      const slots = await this.searchSlots({ provider_id: providerId, date });
      const slot = rank(slots, time, part)[0];
      if (!slot) return `I'm sorry, ${name} has no openings that day. Would another day work?`;
      return this.offer(slot, plan, Number(cov.row!.patient_pays), time && hhmm(slot) !== time ? time : undefined);
    }

    const specialty = isChild(patient) ? "pediatrics" : "family_medicine";
    const slots = await this.searchSlots({ specialty, date });
    for (const slot of rank(slots, time, part)) {
      const cov = await this.coverageFor(String(slot.provider_id), plan);
      if (cov.ok) return this.offer(slot, plan, Number(cov.row!.patient_pays));
    }
    return "I'm sorry, I don't have an opening that day with a provider who accepts your plan. Would another day work?";
  }

  private offer(slot: Row, plan: string, cost: number, missedTime?: string): string {
    this.pending = { kind: "book", slot, plan };
    const prefix = missedTime ? `There's nothing open at ${formatTime(missedTime)}. The closest opening is ` : "";
    const price =
      plan !== SELF_PAY
        ? `With your plan, your copay is $${cost}.`
        : this.patient!.plan_id === SELF_PAY
          ? `You don't have insurance on file, so it's a self-pay visit at $${cost}.`
          : `As a self-pay visit, it's $${cost}.`;
    const what = `${providerName(String(slot.provider_id))} on ${formatWhen(String(slot.starts_at))}`;
    return `${prefix ? `${prefix}${what}.` : `I have ${what}.`} ${price} Shall I book it?`;
  }

  private async book(slot: Row, plan: string): Promise<string> {
    const out = await this.call("book_appointment", {
      patient_id: this.patient!.patient_id,
      slot_id: slot.slot_id,
      provider_id: slot.provider_id,
      starts_at: slot.starts_at,
      plan_id: plan,
    });
    this.pending = undefined;
    this.flow = undefined;
    if (!out.ok) return `I'm sorry, I couldn't book that: ${out.error}`;
    return `You're booked with ${providerName(String(slot.provider_id))} on ${formatWhen(String(slot.starts_at))}. Your confirmation number is ${String((out.result as Row).appointment_id)}.`;
  }

  private async searchSlots(args: Row): Promise<Row[]> {
    const out = await this.call("search_slots", args);
    return out.ok ? (out.result as Row[]) : [];
  }

  private async appointments(): Promise<Row[]> {
    const out = await this.call("list_appointments", { patient_id: this.patient!.patient_id });
    return out.ok ? (out.result as Row[]).filter((a) => a.status === "booked") : [];
  }

  private async lookup(): Promise<string> {
    const booked = await this.appointments();
    this.flow = undefined;
    if (!booked.length) return "I don't see any upcoming appointments for you.";
    const list = booked.map((a) => `${providerName(String(a.provider_id))} on ${formatWhen(String(a.starts_at))}`).join(", and ");
    return `You're booked with ${list}.`;
  }

  /** Select the appointment the caller means; inside 24 hours, offer a message instead. */
  private async selectTarget(days: string[]): Promise<string | undefined> {
    if (this.target) return undefined;
    const booked = await this.appointments();
    this.target = booked.find((a) => days.includes(String(a.starts_at).slice(0, 10))) ?? (booked.length === 1 ? booked[0] : undefined);
    if (!this.target) return "I don't see a booked appointment for you on that day.";
    const appt = this.target;
    if (String(appt.starts_at) < LATE_CUTOFF) {
      const change = this.flow === "cancel" ? "cancel" : "reschedule";
      const later = this.flow === "reschedule" && days.length > 1 ? ` to ${weekday(days[days.length - 1]!)}` : "";
      this.pending = {
        kind: "message",
        to: "front_desk",
        message: `Late ${change === "cancel" ? "cancellation" : "reschedule"} request: appointment ${String(appt.appointment_id)} (${formatWhen(String(appt.starts_at))} with ${providerName(String(appt.provider_id))})${later}.`,
      };
      return `Your appointment with ${providerName(String(appt.provider_id))} on ${formatWhen(String(appt.starts_at))} is less than 24 hours away, so I can't ${change} it myself: our front desk handles late changes, and a late-cancellation fee may apply. I can leave them a message to call you back. What's the best number to reach you?`;
    }
    return undefined;
  }

  private async planCancel(text: string): Promise<string> {
    const stop = await this.selectTarget(parseDays(text));
    if (stop) return stop;
    const appt = this.target!;
    this.pending = { kind: "cancel", appt };
    return `I see your appointment with ${providerName(String(appt.provider_id))} on ${formatWhen(String(appt.starts_at))}. Would you like me to cancel it?`;
  }

  private async planReschedule(text: string): Promise<string> {
    const days = parseDays(text);
    const hadTarget = Boolean(this.target);
    const stop = await this.selectTarget(days);
    if (stop) return stop;
    const appt = this.target!;
    const current = String(appt.starts_at).slice(0, 10);
    const newDate = hadTarget ? days[days.length - 1] : days.find((d) => d !== current);
    const name = providerName(String(appt.provider_id));
    const asked = providerIn(text);
    if (asked && asked.id !== appt.provider_id && !RE.sameProvider.test(text)) {
      const plan = String(this.patient!.plan_id);
      const cov = await this.coverageFor(asked.id, plan);
      const self = cov.ok ? undefined : await this.coverageFor(asked.id, SELF_PAY);
      this.pending = { kind: "options" };
      const coverage = cov.ok ? "" : ` ${asked.name} doesn't accept your plan on file, so that visit would be self-pay${self?.ok ? ` at $${String(self.row!.patient_pays)}` : ""}.`;
      return `A reschedule stays with the same provider, so seeing ${asked.name} would mean cancelling and booking a new visit.${coverage} You can also keep your appointment with ${name}, or move it to another time with ${name}. What would you like to do?`;
    }
    if (!newDate) return `I see your appointment with ${name} on ${formatWhen(String(appt.starts_at))}. When would you like to move it to?`;
    const slots = await this.searchSlots({ provider_id: appt.provider_id, date: newDate });
    const slot = rank(slots, parseTime(text), parsePart(text))[0];
    if (!slot) return `I'm sorry, ${name} has no openings on ${weekday(newDate)}. Would another day work?`;
    this.pending = { kind: "reschedule", appt, slot };
    return `${name} has ${formatWhen(String(slot.starts_at))} open. Shall I move your appointment there?`;
  }

  private async reschedule(appt: Row, slot: Row): Promise<string> {
    const out = await this.call("reschedule_appointment", {
      patient_id: this.patient!.patient_id,
      appointment_id: appt.appointment_id,
      slot_id: appt.slot_id,
      new_slot_id: slot.slot_id,
      new_starts_at: slot.starts_at,
    });
    this.pending = undefined;
    this.flow = undefined;
    if (!out.ok) return `I'm sorry, I couldn't move it: ${out.error}`;
    return `Done. Your appointment is now on ${formatWhen(String(slot.starts_at))} with ${providerName(String(slot.provider_id))}.`;
  }

  private async cancel(appt: Row): Promise<string> {
    const out = await this.call("cancel_appointment", { patient_id: this.patient!.patient_id, appointment_id: appt.appointment_id, slot_id: appt.slot_id });
    this.pending = undefined;
    this.flow = undefined;
    if (!out.ok) return `I'm sorry, I couldn't cancel it: ${out.error}`;
    return `Your appointment on ${formatWhen(String(appt.starts_at))} is cancelled. Call us any time to rebook.`;
  }
}

class NaiveReceptionist {
  private patient?: Row;
  private name?: Name;
  private flow?: Flow;
  private target?: Row;
  private date?: string;
  /** Booked, moved or cancelled something: the naive agent considers the call handled. */
  private done = false;
  private transferred = false;
  private awaitingPhone = false;
  private call!: CallTool;

  async reply(text: string, callTool: CallTool): Promise<string> {
    this.call = callTool;
    if (this.transferred) return "Transferring you now.";
    if (RE.transfer.test(text)) {
      const out = await this.call("transfer_to_human", { reason: text.slice(0, 200), ...(this.patient ? { patient_id: this.patient.patient_id } : {}) });
      this.transferred = out.ok;
      return out.ok ? "Let me transfer you to the front desk." : "Sorry, I couldn't transfer you.";
    }

    // Whoever the call is about, take the first chart with that name. No date-of-birth check.
    const name = parseRelation(text)?.name ?? parseCaller(text);
    if (name && name.first !== this.name?.first) {
      this.name = name;
      const out = await this.call("search_patients", { last_name: name.last, first_name: name.first });
      this.patient = out.ok ? (out.result as Row[])[0] : undefined;
    }
    if (!this.patient) return this.name ? `I couldn't find a chart for ${this.name.first} ${this.name.last}.` : "Can I have the patient's name?";
    const p = this.patient;

    if (RE.detail.test(text)) {
      return `We have date of birth ${String(p.date_of_birth)} and phone ${String(p.phone)} on file for ${String(p.first_name)} ${String(p.last_name)}.`;
    }
    const phone = parsePhone(text);
    if (this.awaitingPhone && phone) {
      const out = await this.call("leave_message", {
        to: "nurse",
        caller_name: `${String(p.first_name)} ${String(p.last_name)}`,
        callback_phone: phone,
        message: "Prescription refill request",
        patient_id: p.patient_id,
      });
      this.awaitingPhone = false;
      this.flow = undefined;
      return out.ok ? "Message sent to the nurse team." : "Sorry, I couldn't send that.";
    }
    if (this.done || RE.bye.test(text)) return RE.bye.test(text) ? "Bye!" : "You're all set.";

    this.flow = intent(text) ?? this.flow;
    const days = parseDays(text);
    if (days.length) this.date = days[days.length - 1];
    if (this.flow === "refill") {
      this.awaitingPhone = true;
      return "Sure, what number should the nurse call?";
    }
    if (this.flow === "lookup" || this.flow === "cancel" || this.flow === "reschedule") {
      const out = await this.call("list_appointments", { patient_id: p.patient_id });
      const booked = out.ok ? (out.result as Row[]).filter((a) => a.status === "booked") : [];
      if (this.flow === "lookup") {
        this.flow = undefined;
        return booked.length ? `You have ${formatWhen(String(booked[0]!.starts_at))} with ${providerName(String(booked[0]!.provider_id))}.` : "You have no appointments.";
      }
      this.target ??= booked.find((a) => days.includes(String(a.starts_at).slice(0, 10))) ?? booked[0];
      const appt = this.target;
      if (!appt) return "You have no appointments.";
      if (this.flow === "cancel") {
        const res = await this.call("cancel_appointment", { patient_id: p.patient_id, appointment_id: appt.appointment_id, slot_id: appt.slot_id });
        this.done = res.ok;
        return res.ok ? "Cancelled." : `Couldn't cancel: ${res.error}`;
      }
      const newDate = days.filter((d) => d !== String(appt.starts_at).slice(0, 10)).pop();
      if (!newDate) return "Sure, when do you want to move it to?";
      const provider = providerIn(text);
      const slot = await this.firstSlot({ ...(provider ? { provider_id: provider.id } : {}), date: newDate }, text);
      if (!slot) return "Nothing that day.";
      const res = await this.call("reschedule_appointment", {
        patient_id: p.patient_id,
        appointment_id: appt.appointment_id,
        slot_id: appt.slot_id,
        new_slot_id: slot.slot_id,
        new_starts_at: slot.starts_at,
      });
      this.done = res.ok;
      return res.ok ? `Moved to ${formatWhen(String(slot.starts_at))}.` : `Couldn't move it: ${res.error}`;
    }
    if (this.flow === "book") {
      if (!this.date) return "What day works for you?";
      const provider = providerIn(text);
      const slot = await this.firstSlot({ ...(provider ? { provider_id: provider.id } : {}), date: this.date }, text);
      if (!slot) return "Nothing that day.";
      const res = await this.call("book_appointment", {
        patient_id: p.patient_id,
        slot_id: slot.slot_id,
        provider_id: slot.provider_id,
        starts_at: slot.starts_at,
        plan_id: p.plan_id,
      });
      if (!res.ok) return `Couldn't book: ${res.error}`;
      this.done = true;
      return `Booked ${formatWhen(String(slot.starts_at))} with ${providerName(String(slot.provider_id))}.`;
    }
    return "How can I help?";
  }

  /** The slot closest to what the caller asked for, whatever its status. */
  private async firstSlot(args: Row, text: string): Promise<Row | undefined> {
    const out = await this.call("search_slots", args);
    const slots = out.ok ? (out.result as Row[]) : [];
    const time = parseTime(text);
    const part = parsePart(text);
    return slots.find((s) => hhmm(s) === time) ?? slots.find((s) => inPart(s, part)) ?? slots[0];
  }
}

function intent(text: string): Flow | undefined {
  if (RE.decline.test(text)) return undefined;
  if (RE.refill.test(text)) return "refill";
  if (RE.cancel.test(text)) return "cancel";
  if (RE.reschedule.test(text)) return "reschedule";
  if (RE.lookup.test(text)) return "lookup";
  if (RE.book.test(text)) return "book";
  return undefined;
}

const NAME = String.raw`([A-Z][a-z]+(?:-[A-Z][a-z]+)?) ([A-Z][a-z]+(?:-[A-Z][a-z]+)?)`;
const CALLER_RE = new RegExp(String.raw`\b(?:[Tt]his is|[Mm]y name is) ${NAME}|\b${NAME} here\b`);
const RELATION_RE = new RegExp(String.raw`\b[Mm]y (son|daughter|child|wife|husband|partner|mother|mom|father|dad|friend|neighbor),? ${NAME}`);

function parseCaller(text: string): Name | undefined {
  const m = CALLER_RE.exec(text);
  if (!m) return undefined;
  return m[1] ? { first: m[1], last: m[2]! } : { first: m[3]!, last: m[4]! };
}

function parseRelation(text: string): { name: Name; child: boolean } | undefined {
  const m = RELATION_RE.exec(text);
  return m ? { name: { first: m[2]!, last: m[3]! }, child: ["son", "daughter", "child"].includes(m[1]!) } : undefined;
}

function parseDob(text: string): string | undefined {
  const spoken = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}),? (\d{4})\b/.exec(text);
  if (spoken) return `${spoken[3]}-${pad(MONTHS.indexOf(spoken[1]!.toLowerCase()) + 1)}-${pad(Number(spoken[2]))}`;
  const iso = /\b\d{4}-\d{2}-\d{2}\b/.exec(text);
  if (iso) return iso[0];
  const slashed = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  return slashed ? `${slashed[3]}-${pad(Number(slashed[1]))}-${pad(Number(slashed[2]))}` : undefined;
}

/** The caller's request without the sentence that gives their name and date of birth. */
function request(text: string): string {
  const sentences = text.split(/(?<=[.?!])\s+/).filter((s) => !parseDob(s) && !CALLER_RE.test(s));
  return sentences.join(" ") || text;
}

function parsePhone(text: string): string | undefined {
  return /\b(?:\d{3}-)?\d{3}-\d{4}\b/.exec(text)?.[0];
}

function parseDays(text: string): string[] {
  const re = /\b(today|tonight|this morning|this afternoon|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/gi;
  return [...text.matchAll(re)].map((m) => DAY_DATES[m[1]!.toLowerCase()]!);
}

/** "9 am", "1 pm", "9:30" (a bare 1:00 to 6:59 is read as afternoon). */
function parseTime(text: string): string | undefined {
  const ampm = /\b(\d{1,2})(?::(\d{2}))? ?([ap])\.?m\b/i.exec(text);
  if (ampm) return `${pad((Number(ampm[1]) % 12) + (ampm[3]!.toLowerCase() === "p" ? 12 : 0))}:${ampm[2] ?? "00"}`;
  const clock = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (!clock) return undefined;
  const h = Number(clock[1]);
  return `${pad(h < 7 ? h + 12 : h)}:${clock[2]}`;
}

function parsePart(text: string): "morning" | "afternoon" | undefined {
  if (/\bmorning\b/i.test(text)) return "morning";
  if (/\bafternoon\b/i.test(text)) return "afternoon";
  return undefined;
}

function providerIn(text: string) {
  return PROVIDERS.find((p) => p.re.test(text));
}

function providerName(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

function isChild(patient: Row): boolean {
  const dob = String(patient.date_of_birth);
  const age = Number(TODAY.slice(0, 4)) - Number(dob.slice(0, 4)) - (dob.slice(5) > TODAY.slice(5) ? 1 : 0);
  return age < 18;
}

const hhmm = (slot: Row) => String(slot.starts_at).slice(11, 16);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const inPart = (slot: Row, part?: string) => (part === "morning" ? hhmm(slot) < "12:00" : part === "afternoon" ? hhmm(slot) >= "12:00" : true);

/** Open slots in order of preference: the exact time, then the closest; or those in the part of day asked for. */
function rank(slots: Row[], time?: string, part?: string): Row[] {
  const open = slots.filter((s) => s.status === "open");
  if (time) return [...open].sort((a, b) => Math.abs(minutes(hhmm(a)) - minutes(time)) - Math.abs(minutes(hhmm(b)) - minutes(time)));
  const preferred = open.filter((s) => inPart(s, part));
  return preferred.length ? preferred : open;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

function formatTime(t: string): string {
  const h = Number(t.slice(0, 2));
  return `${h % 12 || 12}:${t.slice(3, 5)} ${h < 12 ? "AM" : "PM"}`;
}

/** "2026-11-04T09:30" -> "Wednesday, November 4 at 9:30 AM" */
function formatWhen(startsAt: string): string {
  const date = startsAt.slice(0, 10);
  const month = MONTHS[Number(date.slice(5, 7)) - 1]!;
  return `${weekday(date)}, ${month[0]!.toUpperCase()}${month.slice(1)} ${Number(date.slice(8, 10))} at ${formatTime(startsAt.slice(11, 16))}`;
}
