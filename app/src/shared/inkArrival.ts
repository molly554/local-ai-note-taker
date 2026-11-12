/** Visible text owns its clock, not the editor nodes replaced by setContent. */
export class InkArrival {
  private text = ''
  private times: number[] = []

  update(text: string, now: number) {
    let head = 0, tail = 0
    while (head < this.text.length && head < text.length && this.text[head] === text[head]) head++
    while (tail < this.text.length - head && tail < text.length - head && this.text[this.text.length - 1 - tail] === text[text.length - 1 - tail]) tail++
    this.times = [
      ...this.times.slice(0, head),
      ...Array<number>(text.length - head - tail).fill(now),
      ...(tail ? this.times.slice(-tail) : []),
    ]
    this.text = text
    return [...text.matchAll(/\S+/g)].map(m => ({ from: m.index, to: m.index + m[0].length, born: this.times[m.index] }))
  }
}
