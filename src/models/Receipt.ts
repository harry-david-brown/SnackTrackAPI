export class Receipt {
  constructor(
    public userId: string,
    public items: string[],
    public amountSpent: number,
    public emailFrom?: string,
    public emailTo?: string,
    public emailSubject?: string,
    public emailBody?: string
  ) {}
} 