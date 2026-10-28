import { z } from "zod";
export const userSchema = z.string().trim().min(1).max(200);
export const timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
