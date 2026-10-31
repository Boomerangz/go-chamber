interface Operation { echo: string; text: string; backspace?: boolean }

// Predictions are a projection over unconfirmed echo, never writes to xterm.
// A fresh OSC 133 prompt and observed matching echo are required each time.
export class TerminalPrediction {
  private id = 0
  private floor = 0
  private command = 0
  private requiredCommand = 0
  private active = false
  private verified = false
  private confirmed = 0
  private slow = false
  private operations: Operation[] = []
  private changed: () => void
  constructor(changed: () => void) { this.changed = changed }
  rtt(ms: number) { if (ms > 30) this.slow = true; else if (ms < 20) this.slow = false; this.changed() }
  prompt(id: number, active: boolean, command = id - 1) {
    if (id > this.id) { this.operations = []; this.verified = false; this.confirmed = 0 }
    this.id = Math.max(this.id, id)
    this.command = Math.max(this.command, command)
    this.active = active && id > this.floor && command >= this.requiredCommand
    if (!this.active) { this.operations = []; this.verified = false }
    this.changed()
  }
  reset() { this.operations = []; this.verified = false; this.confirmed = 0; this.active = false; this.changed() }
  private abandon() { this.floor = this.id; this.reset() }
  input(text: string) {
    if (text.includes('\r') || text.includes('\n')) { this.requiredCommand = Math.max(this.requiredCommand, this.command) + 1; this.abandon(); return }
    if (!this.active) return
    if (text === '\x7f' || text === '\b') {
      const editable = this.operations.reduce((n, op) => n + (op.backspace ? -1 : op.text.length), this.confirmed)
      if (editable <= 0) { this.abandon(); return }
      this.operations.push({ echo: '\b \b', text: '', backspace: true })
    } else if (/^[\x20-\x7e\u0400-\u0482\u048a-\u04ff]$/.test(text)) this.operations.push({ echo: text, text })
    else { this.abandon(); return }
    if (this.operations.length > 512) { this.abandon(); return }
    this.changed()
  }
  output(text: string) {
    if (!this.active || !text) return
    if (!this.operations.length) { this.abandon(); return }
    for (const ch of text) {
      const op = this.operations[0]
      if (!op || op.echo[0] !== ch) { this.abandon(); return }
      op.echo = op.echo.slice(ch.length)
      if (!op.echo) { this.confirmed += op.backspace ? -1 : op.text.length; this.operations.shift(); this.verified = true }
    }
    this.changed()
  }
  view(): { text: string; offset: number } {
    if (!this.active || !this.verified || !this.slow) return { text: '', offset: 0 }
    let text = '', offset = 0
    for (const op of this.operations) {
      if (op.backspace) { if (text) text = text.slice(0, -1); else offset-- }
      else text += op.text
    }
    return { text: text || (offset < 0 ? ' ' : ''), offset }
  }
}
