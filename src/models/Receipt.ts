export class Receipt {
  constructor(
    public userId: string,
    public items: string[],
    public amountSpent: number
  ) {}
} 