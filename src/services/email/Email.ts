/** Provider-neutral email data returned by an email adapter. */
export class Email {
  constructor(
    public userId: string,
    public from: string,
    public to: string,
    public body: string,
    public subject?: string
  ) {}
}
