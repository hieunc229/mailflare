import { z } from "zod";

const strictEmail = z.string().email();

// Zod 4 emits z.string().email() as a JSON Schema pattern with lookaheads, which OpenRouter rejects.
export const toolEmailSchema = z.string().refine((value) => strictEmail.safeParse(value).success, "Invalid email").meta({ format: "email", description: "A single email address" });
