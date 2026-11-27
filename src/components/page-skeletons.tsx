import { Skeleton } from "@/components/ui/skeleton";

export function MessageDetailSkeleton() {
	return (
		<div className="h-full space-y-6 p-6">
			<div className="flex justify-between">
				<Skeleton className="h-9 w-9 rounded-full" />
				<Skeleton className="h-9 w-48" />
			</div>
			<Skeleton className="h-8 w-3/5" />
			<div className="flex items-start gap-3 border-b border-neutral-100 pb-5">
				<Skeleton className="h-10 w-10 rounded-full" />
				<div className="flex-1 space-y-2">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="h-3 w-32" />
				</div>
				<Skeleton className="h-3 w-28" />
			</div>
			<div className="space-y-3">
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-11/12" />
				<Skeleton className="h-4 w-4/5" />
				<Skeleton className="h-4 w-5/6" />
			</div>
		</div>
	);
}

export function CardGridSkeleton() {
	return (
		<div className="grid gap-3 md:grid-cols-2">
			{Array.from({ length: 4 }, (_, index) => (
				<div
					key={index}
					className="flex min-h-24 items-start gap-3 rounded-lg border border-neutral-200 bg-white p-4"
				>
					<Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
					<div className="min-w-0 flex-1 space-y-2">
						<Skeleton className="h-4 w-2/5" />
						<Skeleton className="h-3.5 w-4/5" />
						<Skeleton className="h-3 w-1/3" />
					</div>
				</div>
			))}
		</div>
	);
}

export function SectionRowSkeleton() {
	return (
		<div className="flex min-h-20 items-center gap-4 rounded-3xl bg-white px-5 py-4">
			<Skeleton className="h-10 w-10 shrink-0 rounded-full" />
			<div className="min-w-0 flex-1 space-y-2">
				<Skeleton className="h-4 w-2/5 max-w-48" />
				<Skeleton className="h-3.5 w-3/5 max-w-80" />
			</div>
		</div>
	);
}
