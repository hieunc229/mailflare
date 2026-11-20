import type { DriveScan } from "@/lib/import/takeout-data-types";

export type TakeoutDriveCardProps = {
	drive: DriveScan;
};

export type DriveStorage = { used?: number; limit: number | null };
