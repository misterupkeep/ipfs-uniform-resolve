/**
 * Indicates resolution could not continue because
 */
export class DeadEndError extends Error {
  /**
   * The path at which resolution failed
   */
  at: string;

  /**
   * The remaining path which could not get resolved
   */
  remaining: string;

  /**
   * The CID of the block at which the error happened
   */
  cid: any;

  constructor(msg: string, cid: any, at: string, remaining: string) {
    super(msg);
    Object.setPrototypeOf(this, DeadEndError.prototype);

    this.cid = cid;
    this.at = at;
    this.remaining = remaining;
  }
}
