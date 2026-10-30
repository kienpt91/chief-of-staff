/** Expected, user-facing failure (bad input, wrong state). The CLI prints the message and exits 2. */
export class CosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CosError";
  }
}
