/**
 * Text-message delivery. In production this is an SMS (and later WhatsApp)
 * provider with a fallback route. SimulatedMessenger keeps sent messages in
 * memory only, so one-time codes are never written anywhere.
 */
export interface Messenger {
  readonly provider: string;
  send(toE164: string, text: string): Promise<{ providerRef: string }>;
}

export interface SentMessage { to: string; text: string; at: Date }

export class SimulatedMessenger implements Messenger {
  readonly provider = "simulated-sms";
  readonly sent: SentMessage[] = [];
  #n = 0;
  /** For tests: make the next n sends fail, as a provider outage would. */
  failNext = 0;
  async send(to: string, text: string): Promise<{ providerRef: string }> {
    if (this.failNext > 0) { this.failNext--; throw new Error("simulated provider outage"); }
    this.sent.push({ to, text, at: new Date() });
    if (this.sent.length > 1000) this.sent.splice(0, this.sent.length - 1000);
    return { providerRef: `SIMSMS-${++this.#n}` };
  }
}
