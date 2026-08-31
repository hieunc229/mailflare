import { updateBarkSettingsSchema } from "@/lib/validators";
import type { UpdateBarkSettingsInput } from "./types";

export async function parseUpdateBarkSettingsRequest(
	request: Request,
): Promise<UpdateBarkSettingsInput> {
	return updateBarkSettingsSchema.parse(await request.json());
}